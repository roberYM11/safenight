import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import test from 'node:test';
import path from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { CloudStore } from '../app/server/cloud/store.ts';
import { cloudRecord } from '../app/server/cloud/contracts.ts';
import { ModelRegistry } from '../app/server/pipeline/models.ts';
import { deriveStep } from '../app/server/pipeline/derive.ts';
import { cachedAssessments, persistPoint } from '../app/server/pipeline/predictions.ts';
import { readDataset } from '../app/server/pipeline/datasets.ts';
import { PipelineError } from '../app/server/pipeline/objects.ts';
import { expectedSplit } from '../app/server/pipeline/evaluation.ts';
import { assessLocation } from '../app/server/location-assessment.ts';

const now = new Date('2026-11-05T06:00:00.000Z');
const TOKEN = 'fixture-only-pipeline-token-0123456789012345';
const modelText = await readFile(new URL('../app/server/data/model.json', import.meta.url), 'utf8');
const manifestText = await readFile(new URL('../app/server/data/manifest.json', import.meta.url), 'utf8');
const model = JSON.parse(modelText), manifest = JSON.parse(manifestText);
const migrations = await Promise.all((await readdir(new URL('../drizzle/', import.meta.url))).filter(n => n.endsWith('.sql')).sort().map(n => readFile(new URL(`../drizzle/${n}`, import.meta.url), 'utf8')));
const compiled = await build({ stdin: { contents: `
  import {pipelineHttp} from './app/server/pipeline/http.ts';
  export default {fetch(request,env){return pipelineHttp(request,{db:env.DB,bucket:env.BUCKET,
    token:${JSON.stringify(TOKEN)},modelText:${JSON.stringify(modelText)},manifestText:${JSON.stringify(manifestText)},clock:()=>new Date(request.headers.get('X-Fixture-Time')??${JSON.stringify(now.toISOString())})});}};
`, resolveDir: path.resolve('.') }, bundle: true, format: 'esm', platform: 'browser', write: false, target: 'es2022' });
async function usingPipeline(run) {
  const mf = new Miniflare({ modules: true, script: compiled.outputFiles[0].text, compatibilityDate: '2026-05-15', d1Databases: ['DB'], r2Buckets: ['BUCKET'] });
  try {
    const db = await mf.getD1Database('DB'), bucket = await mf.getR2Bucket('BUCKET');
    for (const sql of migrations) await db.batch(sql.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
    const call = async (command, at = now) => {
      const response = await mf.dispatchFetch('https://example.test/api/internal/pipeline', { method: 'POST', headers: { 'X-SafeNight-Collection-Token': TOKEN, 'Content-Type': 'application/json', 'X-Fixture-Time': at.toISOString() }, body: JSON.stringify(command) });
      return { status: response.status, value: await response.json() };
    };
    await run({ mf, db, bucket, store: new CloudStore(db, bucket), call });
  } finally { await mf.dispose(); }
}
async function publish(store, source, rows, at = now) {
  const raw = await store.archive(source, new TextEncoder().encode(JSON.stringify(rows)), at);
  const records = await Promise.all(rows.map(row => cloudRecord(source, { published_at: row.observed_at, revision_rank: 1, source_updated_at: null, lat: null, lon: null, payload_json: '{}', ...row }, raw, at)));
  const day = new Date(Date.parse(rows[0].observed_at) + 9 * 3600000).toISOString().slice(0, 10);
  const job = await store.start({ source, day, kind: 'import', expected_count: records.length }, at);
  await store.claim(job.id, 'fixture', at);
  for (let offset = 0; offset < records.length; offset += 200) await store.stage(job.id, 'fixture', { records: records.slice(offset, offset + 200), total_count: records.length, page_no: offset / 200 + 1, page_size: 200 }, at);
  await store.publish(job.id, 'fixture', at);
}
async function seed(store, count = 1) {
  const sites = model.locations.slice(0, count);
  await publish(store, 'sensor_locations', sites.map(point => ({ entity_id: point.sensor_id, lat: point.lat, lon: point.lon, observed_at: '2026-01-01T00:00:00.000Z' })));
  await publish(store, 'sdot', sites.map((point, i) => ({ entity_id: point.sensor_id, observed_at: '2026-11-05T05:00:00.000Z', payload_json: JSON.stringify({ lux: (model.bounds.lux_min + model.bounds.lux_max) / 2 + i / 10, noise_db: (model.bounds.noise_min + model.bounds.noise_max) / 2 }) })));
}
async function drain(db, bucket) {
  for (let i = 0; i < 100; i++) if ((await deriveStep(db, bucket, () => now)).status === 'idle') return;
  assert.fail('outbox did not drain');
}
async function setup(context, count = 1) {
  await seed(context.store, count);
  assert.equal((await context.call({ action: 'bootstrap' })).status, 200);
  await drain(context.db, context.bucket);
}
function constantCandidate(dataset, score = 77) {
  const locations = [...new Map(dataset.rows.map(row => [row.feature.sensor_id, { sensor_id: row.feature.sensor_id, lat: row.feature.lat, lon: row.feature.lon }])).values()].sort((a, b) => a.sensor_id.localeCompare(b.sensor_id));
  const bounds = { lux_min: Math.min(...dataset.rows.map(row => row.feature.lux)), lux_max: Math.max(...dataset.rows.map(row => row.feature.lux)), noise_min: Math.min(...dataset.rows.map(row => row.feature.noise_db)), noise_max: Math.max(...dataset.rows.map(row => row.feature.noise_db)) };
  const payload = { ...model, locations, bounds, trees: Array.from({ length: 114 }, () => [{ feature: -2, threshold: -2, left: -1, right: -1, value: score }]) };
  const text = JSON.stringify(payload), digest = createHash('sha256').update(text).digest('hex');
  const metadata = { ...manifest, version: `rf-environment-v1-${digest.slice(0, 12)}`, training_sha256: dataset.id, artifact_sha256: digest, training_rows: dataset.rows.length, training_sensors: locations.length, training_locations: locations, bounds, train_groups: locations.slice(0, -1).map(row => row.sensor_id), test_groups: locations.slice(-1).map(row => row.sensor_id) };
  return { model_text: text, manifest_text: JSON.stringify(metadata), evaluations: [] };
}

test('protects the Worker pipeline before reading or writing storage', () => usingPipeline(async ({ mf, db }) => {
  // Given: empty protected state. When: bootstrap is requested without a credential.
  const response = await mf.dispatchFetch('https://example.test/api/internal/pipeline', { method: 'POST', body: '{"action":"bootstrap"}' });
  // Then: no model is registered.
  assert.equal(response.status, 401);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM active_models').first()).n, 0);
}));

test('runs the Worker outbox into reusable predictions and point audit records', () => usingPipeline(async context => {
  // Given: published input revisions.
  await seed(context.store, 3); await context.call({ action: 'bootstrap' });
  // When: the actual HTTP step route consumes the outbox.
  for (let i = 0; i < 20; i++) { const response = await context.call({ action: 'step' }); assert.equal(response.status, 200); if (response.value.status === 'idle') break; }
  // Then: exact results, contributors and live freshness policy survive.
  const observations = await context.store.sensors();
  const cached = await cachedAssessments(context.db, observations.sensors, manifest.version, now);
  assert.ok(cached.every(row => row.status === 'SCORED' && row.prediction_id));
  const result = assessLocation(observations.sensors[0], observations.sensors.map((row, i) => ({ ...row, ...cached[i] })), now);
  const id = await persistPoint(context.db, context.bucket, result, observations.sensors.map((row, i) => ({ ...row, prediction_id: cached[i].prediction_id })), null, now);
  assert.equal((await context.db.prepare('SELECT COUNT(*) n FROM point_contributors WHERE assessment_id=?').bind(id).first()).n, result.sensors.length);
  assert.equal((await context.db.prepare('SELECT COUNT(*) n FROM feature_snapshots').first()).n, 3);
  assert.equal((await context.db.prepare('SELECT COUNT(*) n FROM prediction_results').first()).n, 3);
  const exported = await context.mf.dispatchFetch('https://example.test/api/internal/pipeline?features_after=', { headers: { 'X-SafeNight-Collection-Token': TOKEN } });
  const page = await exported.json();
  assert.equal(page.features.length, 3); assert.equal(page.next_cursor, null);
  assert.ok(page.features.every(row => row.id === row.feature.feature_revision));
  const late = await cachedAssessments(context.db, observations.sensors, manifest.version, new Date(now.getTime() + 31 * 3600000));
  assert.ok(late.every(row => row.status === 'STALE' && row.score === null));
  assert.deepEqual((await context.db.prepare('PRAGMA foreign_key_check').all()).results, []);
}));

test('resumes a twenty-row derivation page without repeating or losing keys', () => usingPipeline(async context => {
  // Given: twenty-five inputs and a bootstrapped registry.
  await seed(context.store, 25); await context.call({ action: 'bootstrap' });
  let first = await deriveStep(context.db, context.bucket, () => now);
  for (let i = 0; first.status !== 'pending' && first.status !== 'idle' && i < 10; i++) first = await deriveStep(context.db, context.bucket, () => now);
  assert.equal(first.status, 'pending'); assert.equal(first.processed_rows, 20);
  // When: a fresh consumer resumes durable cursor state.
  await drain(context.db, context.bucket);
  // Then: all keys exist once across publication and upgrade-baseline jobs.
  assert.equal((await context.db.prepare('SELECT COUNT(*) n FROM feature_snapshots').first()).n, 25);
  assert.equal((await context.db.prepare('SELECT COUNT(*) n FROM prediction_results').first()).n, 25);
}));

test('does not commit inputs or cursors when derivation loses its lease', () => usingPipeline(async context => {
  // Given: an initialized pipeline and a new correction.
  await setup(context);
  await publish(context.store, 'sdot', [{ entity_id: model.locations[0].sensor_id, observed_at: '2026-11-05T05:00:00.000Z', revision_rank: 2, payload_json: JSON.stringify({ lux: model.bounds.lux_min, noise_db: model.bounds.noise_min }) }]);
  const before = (await context.db.prepare('SELECT COUNT(*) n FROM feature_snapshots').first()).n;
  const racing = { prepare: context.db.prepare.bind(context.db), batch: async statements => { await context.db.prepare("UPDATE derivation_jobs SET lease_token='other-worker' WHERE status='running'").run(); return context.db.batch(statements); } };
  // When: ownership changes immediately before commit.
  await assert.rejects(() => deriveStep(racing, context.bucket, () => now), /operation_guard_ok/);
  // Then: no partial result is visible, and lease expiry permits replay.
  assert.equal((await context.db.prepare('SELECT COUNT(*) n FROM feature_snapshots').first()).n, before);
  assert.equal((await context.db.prepare("SELECT processed_rows FROM derivation_jobs WHERE status='running'").first()).processed_rows, 0);
  await deriveStep(context.db, context.bucket, () => new Date(now.getTime() + 120001));
  assert.equal((await context.db.prepare('SELECT COUNT(*) n FROM feature_snapshots').first()).n, before + 1);
}));

test('reports missing labels without manufacturing a training run', () => usingPipeline(async context => {
  // Given: valid unlabeled features.
  await setup(context);
  // When: the unattended trainer asks for work.
  const response = await context.call({ action: 'train_next', code_sha: '1'.repeat(40) });
  // Then: no labels or run are invented.
  assert.equal(response.value.status, 'labels_unavailable');
  assert.equal((await context.db.prepare('SELECT COUNT(*) n FROM training_runs').first()).n, 0);
}));

test('freezes external labels and blocks a candidate lacking independent validation', () => usingPipeline(async context => {
  // Given: labeled exact feature revisions.
  await setup(context, 8);
  const features = (await context.db.prepare('SELECT id,as_of FROM feature_snapshots ORDER BY id').all()).results;
  const labels = { action: 'labels', definition: { kind: 'rule_index', description: 'Synthetic test labels', source_name: 'test fixture', source_sha256: 'a'.repeat(64) }, rows: features.map((row, i) => ({ feature_snapshot_id: row.id, target_time: row.as_of, value: 50 + i })) };
  assert.equal((await context.call(labels)).status, 200);
  const plan = await context.call({ action: 'train_next', code_sha: '2'.repeat(40) });
  const dataset = await readDataset(context.db, context.bucket, plan.value.dataset_id);
  // When: registering a forest with no independent evaluation evidence.
  const recorded = await context.call({ action: 'candidate', run_id: plan.value.run_id, ...constantCandidate({ ...dataset, id: plan.value.dataset_id }) });
  assert.equal(recorded.status, 200); assert.equal(recorded.value.report.passed, false);
  const approval = await context.call({ action: 'approve', version: recorded.value.model_version, actor: 'fixture' });
  // Then: activation is blocked, identical data are not retrained, and labels are immutable.
  assert.equal(approval.value.error, 'model_quality_gate_failed');
  assert.equal((await new ModelRegistry(context.db, context.bucket).active()).bundle.metadata.version, manifest.version);
  assert.equal((await context.call({ action: 'train_next', code_sha: '2'.repeat(40) })).value.status, 'unchanged');
  const changed = structuredClone(labels); changed.rows[0].value += 1;
  assert.equal((await context.call(changed)).value.error, 'target_revision_requires_new_definition');
}));

test('serializes concurrent model switches and retains a new rollback generation', () => usingPipeline(async context => {
  // Given: two separately approved fixture artifacts and generation one.
  await setup(context, 3);
  const rows = (await context.db.prepare('SELECT payload_json FROM feature_snapshots').all()).results.map(row => ({ feature: JSON.parse(row.payload_json) }));
  const registry = new ModelRegistry(context.db, context.bucket), versions = [];
  for (const score of [55, 65]) {
    const candidate = constantCandidate({ rows, id: '0'.repeat(64) }, score), meta = JSON.parse(candidate.manifest_text);
    const key = `models/${meta.artifact_sha256}.json`; await context.bucket.put(key, candidate.model_text);
    await context.db.prepare(`INSERT INTO model_artifacts(version,origin,feature_version,target_version,object_key,digest,manifest_json,approval_status,approved_by,approved_at,created_at)
      VALUES(?,'bundled','environment-v1','fixture',?,?,?,'approved','fixture',?,?)`).bind(meta.version, key, meta.artifact_sha256, candidate.manifest_text, now.toISOString(), now.toISOString()).run();
    versions.push(meta.version);
  }
  // When: both operators replace the same expected generation.
  const switched = await Promise.allSettled(versions.map(version => registry.activate(version, 1, 'fixture', 'race', now)));
  // Then: exactly one wins, and rollback appends an event.
  assert.equal(switched.filter(row => row.status === 'fulfilled').length, 1);
  const failure = switched.find(row => row.status === 'rejected').reason;
  assert.ok(failure instanceof PipelineError); assert.equal(failure.code, 'model_generation_conflict');
  await registry.activate(manifest.version, 2, 'fixture', 'rollback', now);
  assert.equal((await registry.active()).generation, 3);
  assert.equal((await registry.active()).bundle.metadata.version, manifest.version);
  assert.equal((await context.db.prepare('SELECT COUNT(*) n FROM model_activations').first()).n, 3);
}));

test('trains from a frozen two-day dataset and promotes only a fully validated candidate', () => usingPipeline(async context => {
  // Given: labels are imported each day, before the subsequent test period begins.
  const firstDay = new Date('2026-11-04T06:00:00.000Z');
  const sites = model.locations.slice(0, 20).map((row, i) => ({ ...row, lat: 37.45 + i * 0.01, lon: 127 }));
  await publish(context.store, 'sensor_locations', sites.map(point => ({ entity_id: point.sensor_id, lat: point.lat, lon: point.lon, observed_at: '2026-01-01T00:00:00.000Z' })), firstDay);
  await context.call({ action: 'bootstrap' }, firstDay);
  let definition, targetVersion;
  for (const [day, clock] of [['04', firstDay], ['05', now]]) {
    await publish(context.store, 'sdot', sites.flatMap(point => Array.from({ length: 10 }, (_, i) => i % 2 ? 50 : 10).map((lux, i) => ({ entity_id: point.sensor_id, observed_at: `2026-11-${day}T05:0${i}:00.000Z`, payload_json: JSON.stringify({ lux, noise_db: 50 }) }))), clock);
    for (let i = 0; i < 100; i++) if ((await deriveStep(context.db, context.bucket, () => clock)).status === 'idle') break;
    const features = (await context.db.prepare('SELECT id,as_of,payload_json FROM feature_snapshots WHERE as_of LIKE ?').bind(`2026-11-${day}%`).all()).results;
    definition = { kind: 'rule_index', description: 'Two-level synthetic fixture rule', rule_version: 'synthetic-v1', source_name: 'synthetic QA only', source_sha256: day === '04' ? '4'.repeat(64) : '5'.repeat(64) };
    const registered = await context.call({ action: 'labels', definition, rows: features.map(row => ({ feature_snapshot_id: row.id, target_time: row.as_of, value: JSON.parse(row.payload_json).lux < 30 ? 40 : 80 })) }, clock);
    assert.equal(registered.status, 200);
    if (targetVersion) assert.equal(registered.value.target_version, targetVersion);
    targetVersion = registered.value.target_version;
  }
  const plan = await context.call({ action: 'train_next', code_sha: '3'.repeat(40) });
  assert.equal(plan.value.status, 'running');
  const dataset = await readDataset(context.db, context.bucket, plan.value.dataset_id);
  let candidate;
  if (process.env.SAFENIGHT_PIPELINE_PYTHON_QA === '1') {
    const directory = await mkdtemp(path.join(tmpdir(), 'safenight-full-pipeline-'));
    try {
      const object = await context.db.prepare('SELECT object_key FROM dataset_snapshots WHERE id=?').bind(plan.value.dataset_id).first();
      const source = await context.bucket.get(object.object_key);
      const snapshot = path.join(directory, 'dataset.json'); await writeFile(snapshot, new Uint8Array(await source.arrayBuffer()));
      const output = execFileSync('uv', ['run', '--locked', 'python', 'scripts/train_pipeline.py', '--snapshot', snapshot, '--output', path.join(directory, 'model')], { cwd: path.resolve('../backend'), maxBuffer: 32 * 1024 * 1024, timeout: 120000, encoding: 'utf8' });
      candidate = JSON.parse(output);
    } finally { await rm(directory, { recursive: true, force: true }); }
  } else {
    const makeForest = async (rows, testRows) => {
      const base = constantCandidate({ rows, id: plan.value.dataset_id });
      const payload = JSON.parse(base.model_text), metadata = JSON.parse(base.manifest_text);
      if (testRows) {
        metadata.train_groups = [...new Set(rows.map(row => row.feature.sensor_id))].sort();
        metadata.test_groups = [...new Set(testRows.map(row => row.feature.sensor_id))].sort();
      }
      payload.trees = Array.from({ length: 114 }, () => [{ feature: 0, threshold: 30, left: 1, right: 2, value: 60 }, { feature: -2, threshold: -2, left: -1, right: -1, value: 40 }, { feature: -2, threshold: -2, left: -1, right: -1, value: 80 }]);
      const text = JSON.stringify(payload), digest = createHash('sha256').update(text).digest('hex');
      return { model_text: text, manifest_text: JSON.stringify({ ...metadata, artifact_sha256: digest, version: `rf-environment-v1-${digest.slice(0, 12)}` }) };
    };
    const evaluations = [];
    for (const kind of ['sensor', 'time', 'region']) {
      const split = await expectedSplit(dataset, kind);
      evaluations.push({ kind, train_ids: split.train.map(row => row.feature_snapshot_id), test_ids: split.test.map(row => row.feature_snapshot_id), ...await makeForest(split.train, split.test) });
    }
    candidate = { ...await makeForest(dataset.rows), evaluations };
  }
  // When: the Worker independently validates evidence, approves and switches the model.
  const recorded = await context.call({ action: 'candidate', run_id: plan.value.run_id, ...candidate });
  assert.equal(recorded.status, 200, JSON.stringify(recorded.value));
  assert.equal(recorded.value.report.passed, true, JSON.stringify(recorded.value.report));
  assert.equal((await context.call({ action: 'approve', version: recorded.value.model_version, actor: 'synthetic-qa' })).status, 200);
  assert.equal((await context.call({ action: 'activate', version: recorded.value.model_version, expected_generation: 1, actor: 'synthetic-qa', reason: 'verified synthetic pipeline' })).status, 200);
  await drain(context.db, context.bucket);
  // Then: requests reuse the new model's persisted results and all three gates are recorded.
  const observations = await context.store.sensors();
  const cached = await cachedAssessments(context.db, observations.sensors, recorded.value.model_version, now);
  assert.ok(cached.every(row => row.status === 'SCORED' && row.score > 75 && row.prediction_id));
  assert.equal((await new ModelRegistry(context.db, context.bucket).active()).generation, 2);
  assert.equal(recorded.value.report.evaluations.length, 3);
}));

test('does not reuse an old label when the currently selected observation is corrected', () => usingPipeline(async context => {
  // Given: two labeled feature revisions followed by a correction to one observation.
  await setup(context, 2);
  const features = (await context.db.prepare('SELECT id,as_of FROM feature_snapshots').all()).results;
  const labeled = await context.call({ action: 'labels', definition: { kind: 'rule_index', description: 'Synthetic correction fixture', source_name: 'fixture', source_sha256: 'c'.repeat(64) },
    rows: features.map(row => ({ feature_snapshot_id: row.id, target_time: row.as_of, value: 60 })) });
  const later = new Date(now.getTime() + 1000);
  await publish(context.store, 'sdot', [{ entity_id: model.locations[0].sensor_id, observed_at: '2026-11-05T05:00:00.000Z', revision_rank: 2, payload_json: JSON.stringify({ lux: model.bounds.lux_min, noise_db: model.bounds.noise_min }) }], later);
  for (let i = 0; i < 10; i++) if ((await deriveStep(context.db, context.bucket, () => later)).status === 'idle') break;
  // When: freezing the next dataset after the correction becomes visible.
  const plan = await context.call({ action: 'train_next', code_sha: '4'.repeat(40), target_version: labeled.value.target_version }, later);
  const dataset = await readDataset(context.db, context.bucket, plan.value.dataset_id);
  // Then: the unlabeled correction is omitted instead of paired with an old value.
  assert.equal(dataset.rows.length, 1);
  assert.notEqual(dataset.rows[0].feature.sensor_id, model.locations[0].sensor_id);
}));
