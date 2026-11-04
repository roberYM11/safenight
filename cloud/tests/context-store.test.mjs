import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { CloudContextStore, CONTEXT_SOURCE_IDS, ContextStoreError } from '../app/server/context-store.ts';
import { sha256 } from '../app/server/cloud/contracts.ts';

const now = new Date('2026-11-04T12:00:00.000Z');
const bytes = text => new TextEncoder().encode(text);
const migrations = await Promise.all((await readdir(new URL('../drizzle/', import.meta.url))).filter(name => name.endsWith('.sql')).sort().map(name => readFile(new URL(`../drizzle/${name}`, import.meta.url), 'utf8')));
async function usingStore(run) {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("fixture"); } }', compatibilityDate: '2026-05-15', d1Databases: ['DB'], r2Buckets: ['BUCKET'] });
  try {
    const db = await mf.getD1Database('DB'); const bucket = await mf.getR2Bucket('BUCKET');
    await db.batch(migrations.flatMap(sql => sql.split('--> statement-breakpoint')).map(sql => sql.trim()).filter(Boolean).map(sql => db.prepare(sql)));
    await run(new CloudContextStore(db, bucket), db, bucket);
  } finally { await mf.dispose(); }
}
async function sourcePart(sourceId, variant = 0, checked = now) {
  const raw = bytes(`${sourceId},fixture-source-content-${variant}`);
  const isCamera = sourceId.endsWith('cctv');
  const source = {
    id: sourceId, title: sourceId, url: `https://www.data.go.kr/data/${sourceId}/fileData.do`, download_url: `https://www.data.go.kr/cmm/fileDownload.do?file=${sourceId}`,
    license: '이용허락범위 제한 없음', license_url: 'https://www.data.go.kr/ugs/selectPortalPolicyView.do', updated_at: checked.toISOString().slice(0, 10), reference_date: '2026-10-01', retrieved_at: checked.toISOString(),
    district: sourceId.startsWith('songpa') ? '송파구' : '서초구', coverage_note: 'synthetic storage fixture, not production facility data',
    raw_sha256: await sha256(raw), source_rows: 1, accepted_rows: 1, rejected_rows: 0,
  };
  const kind = isCamera ? 'cctv' : sourceId === 'songpa-lights' ? 'streetlight' : 'security_light';
  const row = [sourceId, kind, `${sourceId}:facility-1`, '시설 fixture', 37.5 + variant / 1000, 127.1, null];
  if (isCamera) row.push(2, '2026-10-01');
  return { raw, dataset: { format: 'safenight-context-v1', sources: [source], facilities: [row] } };
}
async function combined(variant = 0, checked = now) {
  const parts = await Promise.all(CONTEXT_SOURCE_IDS.map(id => sourcePart(id, variant, checked)));
  return { format: 'safenight-context-v1', sources: parts.flatMap(part => part.dataset.sources), facilities: parts.flatMap(part => part.dataset.facilities) };
}
async function stageOne(store, jobId, token, sourceId, variant, checked = now) {
  const part = await sourcePart(sourceId, variant, checked);
  await store.archive(jobId, { source_id: sourceId, role: 'csv', url: part.dataset.sources[0].download_url, bytes: part.raw, sha256: part.dataset.sources[0].raw_sha256, content_type: 'text/csv' }, checked, token);
  return store.stage(jobId, sourceId, part.dataset, checked, token);
}
async function readyJob(store, variant, checked = now) {
  const job = await store.start(checked); const token = await store.claim(job.id, checked); assert.ok(token);
  for (const sourceId of CONTEXT_SOURCE_IDS) await stageOne(store, job.id, token, sourceId, variant, checked);
  return { job, token };
}
async function count(db, table) { return (await db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).first()).total; }

test('seeds immutable facilities once and never overwrites an existing current pointer', () => usingStore(async (store, db, bucket) => {
  // Given: no persistent facility dataset and a complete bundled fixture.
  const seed = await combined(); await store.ensureSeed(seed, now);
  const first = await store.current();
  // When: another caller tries to seed different fixture content into the same storage.
  await store.ensureSeed(await combined(1), new Date(now.getTime() + 1000));
  const result = await new CloudContextStore(db, bucket).current();
  // Then: original snapshot content, digest identity and check time remain unchanged.
  assert.deepEqual(result, first); assert.deepEqual(result.dataset, seed);
  assert.equal(await count(db, 'context_snapshots'), 1);
  assert.equal(await count(db, 'context_current'), 1);
  assert.equal((await bucket.list({ prefix: 'context/datasets/' })).objects.length, 1);
}));

test('resumes a persisted source cursor after lease takeover and only publishes all four sources together', () => usingStore(async (store, db, bucket) => {
  // Given: one staged source and three remaining sources while old current data stays visible.
  await store.ensureSeed(await combined(), now); const before = await store.current();
  const job = await store.start(now); assert.equal((await store.start(now)).id, job.id);
  const oldToken = await store.claim(job.id, now); assert.ok(oldToken);
  assert.equal(await store.claim(job.id, now), null);
  await stageOne(store, job.id, oldToken, CONTEXT_SOURCE_IDS[0], 1);
  assert.equal((await store.current()).id, before.id);
  const later = new Date(now.getTime() + 121000); const resumed = new CloudContextStore(db, bucket);
  // When: a fresh worker claims the expired lease, resumes three sources, and finalizes.
  const token = await resumed.claim(job.id, later); assert.ok(token);
  await assert.rejects(store.publish(job.id, later, oldToken), error => error instanceof ContextStoreError && error.code === 'context_lease_lost');
  assert.equal((await resumed.get(job.id)).next_source_index, 1);
  for (const sourceId of CONTEXT_SOURCE_IDS.slice(1)) await stageOne(resumed, job.id, token, sourceId, 1, later);
  assert.equal((await resumed.current()).id, before.id);
  const result = await resumed.publish(job.id, later, token);
  // Then: every source changes atomically, and succeeded retries reuse the same daily job.
  assert.equal(result.status, 'succeeded'); assert.equal(result.stage_count, 4); assert.equal(result.unchanged, false);
  assert.notEqual((await resumed.current()).id, before.id);
  assert.equal((await resumed.current()).dataset.facilities.length, 4);
  assert.equal(await count(db, 'context_snapshots'), 2);
  assert.equal((await resumed.start(later)).id, job.id);
  assert.deepEqual(await resumed.publish(job.id, later, 'unused-after-success'), result);
  assert.equal('lease_token' in (await resumed.overview()).jobs[0], false);
}));

test('treats metadata-only daily checks as unchanged and refreshes checked_at without a new data version', () => usingStore(async (store, db) => {
  // Given: a complete initial dataset whose source bytes and facility rows do not change.
  await store.ensureSeed(await combined(), now); const first = await store.current();
  const later = new Date('2026-11-05T12:00:00.000Z');
  const { job, token } = await readyJob(store, 0, later);
  // When: the next day's freshly retrieved source metadata is published.
  const result = await store.publish(job.id, later, token);
  // Then: retrieval dates do not manufacture a new facility version.
  const current = await store.current();
  assert.equal(result.unchanged, true); assert.equal(current.id, first.id);
  assert.equal(current.checked_at, later.toISOString()); assert.deepEqual(current.dataset, first.dataset);
  assert.equal(await count(db, 'context_snapshots'), 1);
  assert.equal(await count(db, 'context_raw_documents'), 4);
  assert.equal((await store.start(new Date('2026-11-05T14:00:00.000Z'))).id, job.id);
  assert.notEqual((await store.start(new Date('2026-11-05T15:00:00.000Z'))).id, job.id);
}));

test('keeps source artifacts and the previous current dataset when a partial refresh fails', () => usingStore(async (store, db) => {
  // Given: a successful seed and one partial source of a new dataset.
  await store.ensureSeed(await combined(), now); const first = await store.current();
  const job = await store.start(now); const token = await store.claim(job.id, now); assert.ok(token);
  await stageOne(store, job.id, token, CONTEXT_SOURCE_IDS[0], 2);
  // When: the next upstream source fails and the job is released.
  const failed = await store.fail(job.id, 'fixture_source_failure', now, token);
  await store.release(job.id, token, now);
  // Then: no partial source becomes current; raw and staged history survive for auditing.
  assert.equal(failed.status, 'failed'); assert.equal(failed.next_source_index, 1);
  assert.deepEqual(await store.current(), first);
  assert.equal(await count(db, 'context_raw_documents'), 1); assert.equal(await count(db, 'context_staged_sources'), 1);
  const retry = await store.start(now); assert.notEqual(retry.id, job.id); assert.equal(retry.next_source_index, 0);
}));

test('atomically rolls back failed final publication and resumes completion without downloading again', () => usingStore(async (store, db) => {
  // Given: four fully staged sources and an actual D1 trigger aborting current publication.
  await store.ensureSeed(await combined(), now); const first = await store.current();
  const { job, token } = await readyJob(store, 1);
  await db.prepare("CREATE TRIGGER fixture_context_block BEFORE UPDATE ON context_current BEGIN SELECT RAISE(ABORT, 'fixture final publication failure'); END").run();
  // When: the final atomic batch fails, then is retried after the storage fault is removed.
  await assert.rejects(store.publish(job.id, now, token));
  assert.equal(await count(db, 'context_snapshots'), 1); assert.deepEqual(await store.current(), first);
  assert.equal((await store.get(job.id)).status, 'running'); assert.equal((await store.get(job.id)).next_source_index, 4);
  await db.prepare('DROP TRIGGER fixture_context_block').run();
  const result = await store.publish(job.id, now, token);
  // Then: one new version is published from existing parts, with no duplicate raw or staged records.
  assert.equal(result.status, 'succeeded'); assert.equal(await count(db, 'context_snapshots'), 2);
  assert.equal(await count(db, 'context_raw_documents'), 4); assert.equal(await count(db, 'context_staged_sources'), 4);
  assert.equal(await count(db, 'operation_guards'), 0);
}));
