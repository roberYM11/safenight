import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { CloudPopulationStore, PopulationStoreError } from '../app/server/population-store.ts';

const now = new Date('2026-11-04T12:00:00.000Z');
const code = 'POI024';
const bytes = value => new TextEncoder().encode(value);
const migrations = await Promise.all((await readdir(new URL('../drizzle/', import.meta.url))).filter(name => name.endsWith('.sql')).sort().map(name => readFile(new URL(`../drizzle/${name}`, import.meta.url), 'utf8')));
async function usingStore(run) {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("fixture"); } }', compatibilityDate: '2026-05-15', d1Databases: ['DB'], r2Buckets: ['BUCKET'] });
  try {
    const db = await mf.getD1Database('DB'); const bucket = await mf.getR2Bucket('BUCKET');
    await db.batch(migrations.flatMap(sql => sql.split('--> statement-breakpoint')).map(sql => sql.trim()).filter(Boolean).map(sql => db.prepare(sql)));
    await run(new CloudPopulationStore(db, bucket), db, bucket);
  } finally { await mf.dispose(); }
}
function observation(changes = {}) {
  return { area: { code, name: '잠실역', category: '발달상권' }, minimum: 3000, maximum: 3500, congestion: '보통', observed_at: '2026-11-04T11:55:00.000Z', fetched_at: now.toISOString(), is_replacement: false, ...changes };
}
async function count(db, table) { return (await db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).first()).total; }

test('archives invalid provider bytes in real R2 before any normalized observation exists', () => usingStore(async (store, db, bucket) => {
  // Given: a malformed source response that cannot be normalized.
  const raw = bytes('upstream returned malformed JSON');
  // When: the provider archives before attempting JSON interpretation.
  const result = await store.archive({ area_code: code, raw, http_status: 502, retrieved_at: now.toISOString() });
  // Then: exact bytes survive without publishing invented population values.
  const saved = await bucket.get(`population/raw/${result.raw_sha256}`);
  assert.deepEqual(new Uint8Array(await saved.arrayBuffer()), raw);
  const metadata = await db.prepare('SELECT * FROM population_raw_objects').first();
  assert.equal(metadata.http_status, 502);
  assert.equal(metadata.source_url, 'https://data.seoul.go.kr/dataList/OA-21778/A/1/datasetView.do');
  assert.equal(await count(db, 'population_observations'), 0);
  assert.equal(await store.read(code, now), null);
}));

test('persists a normalized area aggregate and a ten-minute current cache', () => usingStore(async (store, db, bucket) => {
  // Given: a successful source observation and its raw response.
  const record = observation(); const raw = bytes('{"population":3500}');
  // When: append the successful observation.
  const result = await store.write(code, record, raw, now);
  // Then: public area fields, observation time and retrieval time survive a new store instance.
  const readback = await new CloudPopulationStore(db, bucket).read(code, now);
  assert.deepEqual(readback, result);
  assert.equal(readback.record.minimum, 3000); assert.equal(readback.record.maximum, 3500);
  assert.equal(readback.record.observed_at, '2026-11-04T11:55:00.000Z');
  assert.equal(readback.retrieved_at, now.toISOString());
  assert.equal(readback.expires_at, '2026-11-04T12:10:00.000Z'); assert.equal(readback.fresh, true);
  assert.equal(await count(db, 'population_observations'), 1);
  assert.equal(await count(db, 'population_raw_objects'), 1);
}));

test('marks the exact cache expiry stale without discarding the original observation', () => usingStore(async (store) => {
  // Given: one successfully persisted observation.
  await store.write(code, observation(), bytes('successful payload'), now);
  // When: read at the ten-minute expiry boundary.
  const cached = await store.read(code, new Date(now.getTime() + 600000));
  // Then: callers can show explicitly stale fallback data but cannot call it fresh.
  assert.equal(cached.fresh, false);
  assert.equal(cached.record.maximum, 3500);
  assert.equal(cached.record.observed_at, '2026-11-04T11:55:00.000Z');
}));

test('preserves a valid zero population range instead of interpreting it as missing', () => usingStore(async (store) => {
  // Given: the provider explicitly reports zero as both range endpoints.
  const record = observation({ minimum: 0, maximum: 0 });
  // When: persist and read the public aggregate.
  const result = await store.write(code, record, bytes('explicit zero aggregate'), now);
  // Then: zero remains a known observed value in a fresh cache entry.
  assert.equal(result.record.minimum, 0); assert.equal(result.record.maximum, 0);
  assert.equal(result.fresh, true);
}));

test('deduplicates identical area/time/raw observations while refreshing successful retrieval metadata', () => usingStore(async (store, db) => {
  // Given: an archived source observation fetched again one minute later without a source change.
  const raw = bytes('unchanged payload'); await store.write(code, observation(), raw, now);
  const later = new Date(now.getTime() + 60000);
  // When: the same area, source time and raw bytes are persisted again.
  const result = await store.write(code, observation({ fetched_at: later.toISOString() }), raw, later);
  // Then: immutable history remains one row, and cache metadata records the new successful check.
  assert.equal(await count(db, 'population_observations'), 1);
  assert.equal(await count(db, 'population_raw_objects'), 1);
  assert.equal(result.record.fetched_at, now.toISOString());
  assert.equal(result.retrieved_at, later.toISOString());
  assert.equal(result.expires_at, '2026-11-04T12:11:00.000Z');
}));

test('retains a same-time source correction under a new raw digest and updates the current pointer', () => usingStore(async (store, db) => {
  // Given: an earlier value for one source observation time.
  const first = await store.write(code, observation(), bytes('first version'), now);
  const later = new Date(now.getTime() + 60000);
  // When: source bytes change for the same area and observation time.
  const result = await store.write(code, observation({ minimum: 3200, maximum: 3800, fetched_at: later.toISOString() }), bytes('corrected version'), later);
  // Then: both versions remain available and current points at the later retrieval.
  assert.equal(await count(db, 'population_observations'), 2);
  assert.equal(await count(db, 'population_raw_objects'), 2);
  assert.notEqual(result.raw_sha256, first.raw_sha256);
  assert.equal(result.record.maximum, 3800);
}));

test('a rejected provider response cannot replace or refresh an earlier successful cache', () => usingStore(async (store, db) => {
  // Given: one current successful observation.
  const first = await store.write(code, observation(), bytes('success'), now);
  // When: a later upstream failure is archived without writing an observation.
  await store.archive({ area_code: code, raw: bytes('{"RESULT":{"CODE":"ERROR-300"}}'), http_status: 403, retrieved_at: '2026-11-04T12:15:00.000Z' });
  const result = await store.read(code, new Date('2026-11-04T12:15:00.000Z'));
  // Then: source failure remains raw history while successful cache age and value stay unchanged.
  assert.equal(result.fresh, false); assert.equal(result.raw_sha256, first.raw_sha256);
  assert.equal(result.retrieved_at, first.retrieved_at); assert.equal(result.expires_at, first.expires_at);
  assert.equal(await count(db, 'population_observations'), 1);
  assert.equal(await count(db, 'population_raw_objects'), 2);
}));

test('archives an older source observation without rolling current population backward', () => usingStore(async (store, db) => {
  // Given: the latest successful population observation.
  const first = await store.write(code, observation(), bytes('newer source time'), now);
  const later = new Date(now.getTime() + 60000);
  // When: a delayed upstream response carries an older source observation time.
  const result = await store.write(code, observation({ observed_at: '2026-11-04T11:50:00.000Z', maximum: 5000, fetched_at: later.toISOString() }), bytes('older source time'), later);
  // Then: history retains it, but the published value and cache lifetime never regress.
  assert.equal(await count(db, 'population_observations'), 2);
  assert.equal(result.raw_sha256, first.raw_sha256); assert.equal(result.expires_at, first.expires_at);
}));

test('refuses a delayed same-time response to overwrite a newer successful retrieval', () => usingStore(async (store, db) => {
  // Given: one observation already retrieved at noon.
  const first = await store.write(code, observation(), bytes('latest retrieval'), now);
  // When: an earlier-started request completes later with different bytes for the same source time.
  const result = await store.write(code, observation({ maximum: 9000, fetched_at: '2026-11-04T11:59:00.000Z' }), bytes('delayed response'), new Date(now.getTime() + 5000));
  // Then: the delayed response is preserved but cannot replace the more recent successful read.
  assert.equal(await count(db, 'population_observations'), 2);
  assert.equal(result.raw_sha256, first.raw_sha256); assert.equal(result.record.maximum, 3500);
}));

test('rolls back history publication when the cache transaction fails while retaining the raw response', () => usingStore(async (store, db) => {
  // Given: an actual D1 trigger simulating a publication failure after the observation insert.
  await db.prepare("CREATE TRIGGER fixture_block_population BEFORE INSERT ON population_cache BEGIN SELECT RAISE(ABORT, 'fixture publication failure'); END").run();
  // When: the atomic observation/cache batch fails.
  await assert.rejects(store.write(code, observation(), bytes('source response before failure'), now));
  // Then: neither half-published history nor a current pointer exists; raw bytes are preserved.
  assert.equal(await count(db, 'population_observations'), 0);
  assert.equal(await count(db, 'population_cache'), 0);
  assert.equal(await count(db, 'population_raw_objects'), 1);
}));

test('rejects oversized raw data and mismatched or personal-location fields before publication', () => usingStore(async (store, db) => {
  // Given: invalid persistence inputs rather than official aggregate observations.
  const tooLarge = new Uint8Array(1024 * 1024 + 1);
  // When / Then: typed boundary failures do not create history or a published pointer.
  await assert.rejects(store.archive({ area_code: code, raw: tooLarge, http_status: 200, retrieved_at: now.toISOString() }), error => error instanceof PopulationStoreError && error.code === 'population_raw_size_exceeded');
  await assert.rejects(store.write('POI099', observation(), bytes('mismatch'), now), error => error instanceof PopulationStoreError && error.code === 'population_area_mismatch');
  await assert.rejects(store.write(code, { ...observation(), lat: 37.513, lon: 127.1 }, bytes('user point'), now), error => error instanceof PopulationStoreError && error.code === 'invalid_population_record');
  await assert.rejects(store.write(code, observation({ minimum: 9000, maximum: 2000 }), bytes('inverted range'), now), error => error instanceof PopulationStoreError && error.code === 'invalid_population_record');
  assert.equal(await count(db, 'population_raw_objects'), 0); assert.equal(await count(db, 'population_observations'), 0);
  assert.equal(await count(db, 'population_cache'), 0);
}));

test('normalizes equivalent timestamp offsets before constructing immutable identity', () => usingStore(async (store, db) => {
  // Given: the same raw source observation described in UTC and Korean local offset.
  const raw = bytes('one source payload'); await store.write(code, observation(), raw, now);
  // When: the equivalent local timestamp crosses the store boundary.
  await store.write(code, observation({ observed_at: '2026-11-04T20:55:00.000+09:00' }), raw, now);
  // Then: it does not manufacture a second logical source time.
  assert.equal(await count(db, 'population_observations'), 1);
}));

test('limits a shared area across independent consumers and retains failure backoff after release', () => usingStore(async (store, db, bucket) => {
  // Given: separate instances share only D1 and R2.
  const other = new CloudPopulationStore(db, bucket);
  // When: both try to own the same provider request window.
  const tokens = await Promise.all([store.acquire(code, now), other.acquire(code, now)]);
  // Then: one request is allowed; finishing it doesn't bypass the ten-minute rate limit.
  assert.equal(tokens.filter(Boolean).length, 1);
  const token = tokens.find(Boolean);
  await store.release(code, token, now);
  assert.equal(await other.acquire(code, new Date(now.getTime() + 31000)), null);
  assert.equal(typeof await other.acquire(code, new Date(now.getTime() + 600000)), 'string');
}));
