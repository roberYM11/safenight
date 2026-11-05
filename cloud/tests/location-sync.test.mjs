import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import ky from 'ky';
import { Miniflare } from 'miniflare';
import { createClient, send, sha256 } from '../scripts/cloud-client.mjs';
import { CATALOG, DOWNLOAD, discoverWorkbook, syncLocations } from '../scripts/sync-locations.mjs';

const token = 'local-location-sync-fixture-only-token';
const title = '서울시 도시데이터 센서(S-DoT) 환경정보 설치 위치정보.xlsx';
const row = (name, seq, date) => `<tr><td><span title="${name}" onclick="javascript:downloadFile('${seq}');">${name}</span></td><td>${date}</td></tr>`;
const catalog = `<table>${row('S_DOT_ENV.csv', '100', '2026.11.02.')}${row(title, '9', '2026.01.10.')}${row(title, '20260310', '2026.03.10.')}</table>`;

test('rejects missing and ambiguous provider workbook selectors', () => {
  assert.throws(() => discoverWorkbook('<tr><td>CSV only</td></tr>'), { code: 'location_file_missing_or_ambiguous' });
  assert.throws(() => discoverWorkbook(catalog + row(title, '111', '2026.03.10.')), { code: 'location_file_missing_or_ambiguous' });
});

test('normalizes workbooks and publishes through the actual protected Worker routes, D1 and R2', async t => {
  const tmp = await mkdtemp(join(tmpdir(), 'safenight-location-sync-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const python = fileURLToPath(new URL('../../backend/.venv/bin/python', import.meta.url));
  function makeWorkbook(name, firstLatitude) {
    const path = join(tmp, name);
    execFileSync(python, ['-c', `from openpyxl import Workbook
import sys
book = Workbook()
sheet = book.active
sheet.append(["모델 시리얼(*)", "위도", "경도"])
for i in range(201):
    sheet.append([f"TEST-{i}", float(sys.argv[2]) if i == 0 else 37.5, 127.0])
book.save(sys.argv[1])
book.close()`, path, String(firstLatitude)]);
    return readFile(path);
  }
  const [original, corrected, malformed] = await Promise.all([
    makeWorkbook('original.xlsx', 37.51), makeWorkbook('correction.xlsx', 37.54), makeWorkbook('wrong-coordinates.xlsx', 75),
  ]);
  const worker = await build({ stdin: { resolveDir: root, contents: `
    import * as collection from './app/api/internal/collection/route.ts';
    import * as raw from './app/api/internal/raw/route.ts';
    import * as ingest from './app/api/internal/import/route.ts';
    export default {fetch(request) {
      const routes = {collection,raw,import:ingest};
      return routes[new URL(request.url).pathname.split('/').pop()][request.method](request);
    }};
  ` }, bundle: true, format: 'esm', platform: 'browser', external: ['cloudflare:workers'], write: false });
  const mf = new Miniflare({ modules: true, compatibilityDate: '2026-05-15', cf: false,
    d1Databases: ['DB'], r2Buckets: ['BUCKET'], bindings: { SAFENIGHT_COLLECT_AUTH_TOKEN: token }, script: worker.outputFiles[0].text });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  const bucket = await mf.getR2Bucket('BUCKET');
  const migrationDir = join(root, 'drizzle');
  for (const name of (await readdir(migrationDir)).filter(name => name.endsWith('.sql')).sort()) {
    const sql = await readFile(join(migrationDir, name), 'utf8');
    await db.batch(sql.split('--> statement-breakpoint').map(item => item.trim()).filter(Boolean).map(item => db.prepare(item)));
  }
  let workbook = original;
  let interrupt = false;
  const provider = ky.create({ fetch: async request => {
    assert.equal(request.headers.has('X-SafeNight-Collection-Token'), false);
    assert.equal(request.headers.has('OAI-Sites-Authorization'), false);
    if (request.url === CATALOG) return new Response(catalog);
    assert.equal(request.url, DOWNLOAD);
    assert.equal(request.method, 'POST');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(await request.text())), { infId: 'OA-22833', infSeq: '3', seq: '20260310', seqNo: '' });
    return new Response(workbook);
  } });
  const calls = [];
  const client = createClient(token, { fetch: async request => {
    const route = new URL(request.url).pathname.split('/').pop();
    const bytes = request.body ? await request.arrayBuffer() : undefined;
    calls.push(route);
    if (interrupt && route === 'import' && JSON.parse(Buffer.from(bytes)).page_no === 2) {
      return Response.json({ error: 'fixture_interruption' }, { status: 400 });
    }
    return mf.dispatchFetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers), body: bytes });
  } });
  const count = table => db.prepare(`SELECT count(*) AS n FROM ${table}`).first('n');
  const current = () => db.prepare(`SELECT r.lat,r.raw_sha,r.observed_at FROM current_observations c
    JOIN observation_revisions r ON c.revision_id=r.id WHERE c.entity_id='TEST-0'`).first();

  await t.test('keeps the interrupted 200-row first page private', async () => {
    interrupt = true;
    await assert.rejects(syncLocations(client, provider), { serverCode: 'fixture_interruption' });
    assert.equal(await count('observation_revisions'), 200);
    assert.equal(await count('current_observations'), 0);
    assert.equal(await count('derivation_jobs'), 0);
    assert.deepEqual(Buffer.from(await (await bucket.get(`raw/${sha256(original)}`)).arrayBuffer()), original);
  });
  await t.test('resumes only the last page with the original provider date', async () => {
    interrupt = false;
    calls.length = 0;
    const result = await syncLocations(client, provider);
    assert.equal(result.status, 'published');
    assert.equal(calls.filter(call => call === 'import').length, 1);
    assert.deepEqual(await current(), { lat: 37.51, raw_sha: sha256(original), observed_at: '2026-03-09T15:00:00.000Z' });
    assert.equal(await count('current_observations'), 201);
    assert.equal(await count('observation_publications'), 1);
    assert.equal(await count('derivation_jobs'), 1);
  });
  await t.test('performs no raw or import write for identical bytes across independent runs', async () => {
    calls.length = 0;
    const result = await syncLocations(client, provider);
    assert.equal(result.status, 'unchanged');
    assert.deepEqual(calls, ['collection']);
    assert.equal(await count('collection_jobs'), 1);
    assert.equal(await count('observation_revisions'), 201);
  });
  await t.test('rejects HTML and an XLSX with invalid Korean coordinates before any cloud request', async () => {
    calls.length = 0;
    for (const invalid of [Buffer.from('<html>upstream outage</html>'), malformed]) {
      workbook = invalid;
      await assert.rejects(syncLocations(client, provider));
    }
    assert.deepEqual(calls, []);
    assert.equal(await count('raw_objects'), 1);
    assert.equal(await count('observation_publications'), 1);
  });
  await t.test('publishes a same-day correction and a later reversion as separate revisions', async () => {
    for (const [body, latitude] of [[corrected, 37.54], [original, 37.51]]) {
      workbook = body;
      assert.equal((await syncLocations(client, provider)).status, 'published');
      assert.equal((await current()).lat, latitude);
    }
    assert.equal(await count('collection_jobs'), 3);
    assert.equal(await count('observation_revisions'), 603);
    assert.equal(await count('raw_objects'), 2);
    assert.equal(await count('derivation_jobs'), 3);
  });
  await t.test('keeps changed bytes out of a partial job and supersedes it once idle', async () => {
    workbook = corrected;
    interrupt = true;
    await assert.rejects(syncLocations(client, provider), { serverCode: 'fixture_interruption' });
    interrupt = false;
    workbook = original;
    await assert.rejects(syncLocations(client, provider), { serverCode: 'source_busy' });
    await db.prepare("UPDATE collection_jobs SET updated_at='2000-01-01T00:00:00.000Z' WHERE status='running'").run();
    assert.equal((await syncLocations(client, provider)).status, 'unchanged');
    assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM collection_jobs WHERE error_code='location_snapshot_superseded'").first('n'), 1);
    assert.equal(await count('observation_publications'), 3);
    assert.equal((await current()).lat, 37.51);
  });
  await t.test('recognizes a previously completed migration with an ordinary UUID job id', async () => {
    // A legacy import kept the original XLSX and JobRevision rows, without the digest-keyed id.
    const legacy = await send(client, '/api/internal/collection', { method: 'POST', json: {
      action: 'start', kind: 'import', source: 'sensor_locations', day: '2026-03-10', expected_count: 201,
    } });
    assert.equal(legacy.id.startsWith('loc:'), false);
    const { results } = await db.prepare(`SELECT r.entity_id,r.observed_at,r.published_at,r.revision_rank,
      r.source_updated_at,r.payload_json,r.lat,r.lon,r.raw_sha FROM current_observations c
      JOIN observation_revisions r ON r.id=c.revision_id ORDER BY c.entity_id`).all();
    for (const [i, records] of [results.slice(0, 200), results.slice(200)].entries()) {
      await send(client, '/api/internal/import', { method: 'POST', json: { job_id: legacy.id, page_no: i+1, records } });
    }
    calls.length = 0;
    assert.deepEqual(await syncLocations(client, provider), {
      status: 'unchanged', day: '2026-03-10', sha256: sha256(original), sensors: 201, job_id: legacy.id,
    });
    assert.deepEqual(calls, ['collection']);
  });
});
