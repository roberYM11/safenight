import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import boundaries from '../app/server/data/population-areas.json' with { type: 'json' };
import { createClient, ClientFailure } from '../scripts/cloud-client.mjs';
import { runPipeline } from '../scripts/pipeline-client.mjs';

const token = 'fixture-population-writer-0123456789';
const firstArea = boundaries.areas[0];
const script = await build({
  stdin: { contents: "import {POST} from './app/api/internal/population/route.ts'; export default { fetch: POST };", resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
  bundle: true, format: 'esm', platform: 'browser', write: false, target: 'es2022', external: ['cloudflare:workers'],
});
const directory = new URL('../drizzle/', import.meta.url);
const migrations = await Promise.all((await readdir(directory)).filter(name => name.endsWith('.sql')).sort().map(name => readFile(new URL(name, directory), 'utf8')));

function raw(area) {
  return JSON.stringify({ RESULT: { CODE: 'INFO-000' }, 'SeoulRtd.citydata_ppltn': [{
    AREA_CD: area.code, AREA_NM: area.name, AREA_PPLTN_MIN: '120', AREA_PPLTN_MAX: '180',
    AREA_CONGEST_LVL: '보통', PPLTN_TIME: '2026-01-01 00:00', REPLACE_YN: 'N',
  }] });
}
async function fixture(t, upstream = area => new Response(raw(area))) {
  const calls = [];
  const mf = new Miniflare({
    modules: true, compatibilityDate: '2026-05-15', cf: false, script: script.outputFiles[0].text,
    bindings: { SAFENIGHT_COLLECT_AUTH_TOKEN: token, SAFENIGHT_SDOT_API_KEY: 'fixture-population-key' }, d1Databases: ['DB'], r2Buckets: ['BUCKET'],
    outboundService(request) {
      const url = new URL(request.url);
      assert.equal(url.host, 'openapi.seoul.go.kr:8088');
      const area = boundaries.areas.find(entry => entry.name === decodeURIComponent(url.pathname.split('/').at(-1)));
      assert.ok(area);
      calls.push(area.code);
      return upstream(area);
    },
  });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  const bucket = await mf.getR2Bucket('BUCKET');
  await db.batch(migrations.flatMap(sql => sql.split('--> statement-breakpoint')).map(sql => sql.trim()).filter(Boolean).map(sql => db.prepare(sql)));
  const dispatch = (input, init) => mf.dispatchFetch(input, init);
  const post = (body, credential = token) => dispatch('https://fixture.test/api/internal/population', {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'X-SafeNight-Collection-Token': credential, 'Content-Type': 'application/json' },
  });
  const client = createClient(token, { fetch: request => dispatch(request.url, request) });
  return { calls, db, bucket, post, client };
}

test('stores exact upstream bytes and a normalized observation and reuses the published cache on retry', async t => {
  const { calls, db, bucket, post } = await fixture(t);
  const command = { cursor: 0, limit: 1 };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await post(command);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(body, { areas: [{ area_code: firstArea.code, status: 'ok' }], total: boundaries.areas.length, next_cursor: 1 });
    t.diagnostic(JSON.stringify({ attempt, http: res.status, body }));
  }
  const rows = await db.prepare('SELECT c.area_code,o.payload_json,r.object_key FROM population_cache c JOIN population_observations o ON o.id=c.observation_id JOIN population_raw_objects r ON r.sha256=o.raw_sha256').all();
  assert.equal(rows.results.length, 1);
  const row = rows.results[0];
  const record = JSON.parse(row.payload_json);
  assert.deepEqual(record.area, { code: firstArea.code, name: firstArea.name, category: firstArea.category });
  assert.deepEqual([record.minimum, record.maximum], [120, 180]);
  assert.equal(await (await bucket.get(row.object_key)).text(), raw(firstArea));
  assert.deepEqual(calls, [firstArea.code]);
  t.diagnostic(JSON.stringify({ area: row.area_code, minimum: record.minimum, maximum: record.maximum, r2_key: row.object_key, upstream_calls: calls.length, joined_d1_rows: rows.results.length }));
});

test('rejects unauthorized, malformed, out-of-roster, oversized and coordinate-bearing commands before writes', async t => {
  const { db, calls, bucket, post } = await fixture(t);
  for (const [body, credential, expected] of [
    [{ cursor: 0 }, 'wrong', 401], ['{', token, 400], [{ cursor: -1 }, token, 400],
    [{ cursor: boundaries.areas.length }, token, 400], [{ cursor: 0, limit: 4 }, token, 400],
    [{ cursor: 0, lat: 37, lon: 127 }, token, 400], [' '.repeat(300), token, 413],
  ]) {
    const res = await post(body, credential);
    assert.equal(res.status, expected);
    t.diagnostic(JSON.stringify({ http: res.status, body: await res.json() }));
  }
  for (const table of ['population_request_leases', 'population_raw_objects', 'population_observations', 'population_cache']) {
    assert.equal(await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first('n'), 0);
  }
  assert.equal((await bucket.list()).objects.length, 0);
  assert.deepEqual(calls, []);
});

test('invalid refresh archives rejected bytes, retains the prior cache, and lease backoff prevents a second source call', async t => {
  let invalid = false;
  const { calls, db, bucket, post } = await fixture(t, area => new Response(invalid ? 'invalid source bytes' : raw(area)));
  const command = { cursor: 0, limit: 1 };
  assert.equal((await (await post(command)).json()).areas[0].status, 'ok');
  await db.prepare("UPDATE population_cache SET expires_at='2020-01-01T00:00:00.000Z'").run();
  await db.prepare("UPDATE population_request_leases SET next_allowed_at='2020-01-01T00:00:00.000Z'").run();
  const before = await db.prepare('SELECT * FROM population_cache').first();
  invalid = true;
  for (const reason of ['invalid_source_payload', 'request_throttled']) {
    const res = await post(command);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(body.areas, [{ area_code: firstArea.code, status: 'failed', reason }]);
    t.diagnostic(JSON.stringify({ http: res.status, body }));
  }
  assert.deepEqual(await db.prepare('SELECT * FROM population_cache').first(), before);
  assert.equal(await db.prepare('SELECT COUNT(*) FROM population_observations').first('COUNT(*)'), 1);
  assert.equal((await bucket.list()).objects.length, 2);
  assert.deepEqual(calls, [firstArea.code, firstArea.code]);
});

test('concurrent cold requests share one D1 lease and one upstream request', async t => {
  const { calls, post, db } = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 3 }, () => post({ cursor: 0, limit: 1 })));
  const outcomes = [];
  for (const response of responses) {
    assert.equal(response.status, 200);
    const { areas: [area] } = await response.json();
    assert.ok(area.status === 'ok' || (area.status === 'failed' && area.reason === 'request_throttled'));
    outcomes.push(area.status);
  }
  assert.ok(outcomes.includes('ok'));
  assert.deepEqual(calls, [firstArea.code]);
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM population_cache').first('n'), 1);
  t.diagnostic(JSON.stringify({ requests: outcomes.length, outcomes, upstream_calls: calls.length }));
});

test('lease storage faults return a retryable HTTP failure without contacting the upstream', async t => {
  const { calls, post, db } = await fixture(t);
  await db.prepare('DROP TABLE population_request_leases').run();
  const res = await post({ cursor: 0, limit: 1 });
  const body = await res.json();
  assert.equal(res.status, 503);
  assert.deepEqual(body, { error: 'population_collection_unavailable' });
  assert.deepEqual(calls, []);
  t.diagnostic(JSON.stringify({ http: res.status, body, upstream_calls: calls.length }));
});

test('scheduled client completes all published areas through Worker HTTP and never succeeds with a failed area', async t => {
  const failingArea = boundaries.areas[0];
  const { calls, client, db } = await fixture(t, area => area.code === failingArea.code ? new Response('service unavailable', { status: 503 }) : new Response(raw(area)));
  await assert.rejects(runPipeline('population', token, {}, client), e => e instanceof ClientFailure && e.code === 'population_collection_incomplete');
  assert.deepEqual(calls.toSorted(), boundaries.areas.map(area => area.code).toSorted());
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM population_cache').first('n'), boundaries.areas.length - 1);
  t.diagnostic(JSON.stringify({ attempted: calls.length, published: boundaries.areas.length - 1, failed: failingArea.code }));
});

test('scheduled client verifies the complete published roster and rejects premature completion', async t => {
  const { client, db } = await fixture(t);
  const result = await runPipeline('population', token, {}, client);
  assert.deepEqual(result, { status: 'complete', areas: boundaries.areas.length });
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM population_cache').first('n'), boundaries.areas.length);
  t.diagnostic(JSON.stringify(result));
  const truncated = createClient(token, { fetch: async () => Response.json({ areas: [{ area_code: firstArea.code, status: 'ok' }], next_cursor: null, total: 1 }) });
  await assert.rejects(runPipeline('population', token, {}, truncated), e => e instanceof ClientFailure && e.code === 'population_cursor_mismatch');
});
