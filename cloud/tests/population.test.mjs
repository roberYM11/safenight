import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { distanceToPopulationArea, findPopulationArea, insidePopulationArea, matchPopulationArea, parsePopulation, PopulationError, populationPointSchema, populationResult, PopulationService } from '../app/server/population.ts';

const now = new Date('2026-11-04T12:00:00.000Z');
const point = { lat: 37.5, lon: 127 };
const ring = [[126.99, 37.49], [127.01, 37.49], [127.01, 37.51], [126.99, 37.51], [126.99, 37.49]];
const area = { code: 'POI014', name: '강남역', category: '인구밀집지역', bbox: [126.99, 37.49, 127.01, 37.51], rings: [ring] };
const row = overrides => ({ AREA_NM: area.name, AREA_CD: area.code, AREA_PPLTN_MIN: '1000', AREA_PPLTN_MAX: '1500', AREA_CONGEST_LVL: '보통', PPLTN_TIME: '2026-11-04 20:55', REPLACE_YN: 'N', ...overrides });
const payload = overrides => ({ 'SeoulRtd.citydata_ppltn': [row(overrides)], RESULT: { 'RESULT.CODE': 'INFO-000' } });
const expectedCode = expected => error => error instanceof PopulationError && error.code === expected;
const observation = () => parsePopulation(payload(), area, now.toISOString());

test('uses exact official polygons rather than their bounding rectangles or nearest labels', () => {
  // Given: real source boundaries have a narrow exclusion west of Jamsil station's OSM center.
  // When/Then: the outside point stays uncovered; other actual station points resolve their real area.
  assert.equal(findPopulationArea({ lat: 37.5132169, lon: 127.1001365 }), null);
  assert.equal(findPopulationArea({ lat: 37.4979497, lon: 127.0275574 }).name, '강남역');
  assert.equal(findPopulationArea({ lat: 37.5545547, lon: 126.9707793 }).name, '서울역');
});

test('handles polygon boundaries, holes and overlapping source areas', () => {
  // Given: a hole removes the center of one polygon, and a narrower area overlaps the large region.
  const hole = [[126.999, 37.499], [127.001, 37.499], [127.001, 37.501], [126.999, 37.501], [126.999, 37.499]];
  const small = { ...area, code: 'POI015', bbox: [126.995, 37.495, 127.005, 37.505], rings: [[[126.995, 37.495], [127.005, 37.495], [127.005, 37.505], [126.995, 37.505], [126.995, 37.495]]] };
  // When/Then: geographic inclusion and smallest-area selection preserve the actual point.
  assert.equal(insidePopulationArea(point, { ...area, rings: [ring, hole] }), false);
  assert.equal(insidePopulationArea({ lat: 37.5, lon: 126.99 }, area), true);
  assert.equal(findPopulationArea(point, [area, small]).code, 'POI015');
});

test('uses actual segment distance for a nearby area and rejects regions farther than 250m', () => {
  // Given: the point is close to the west boundary but over a kilometer from the polygon centroid.
  const near = { lat: 37.5, lon: 126.989 };
  // When: matching nearby public geography without moving the point into it.
  const match = matchPopulationArea(near, [area]);
  // Then: the boundary distance, not centroid distance or a bounding-box containment, determines coverage.
  assert.equal(insidePopulationArea(near, area), false);
  assert.equal(match.area_relation, 'NEARBY_AREA');
  assert.ok(match.distance_to_area_m > 88 && match.distance_to_area_m < 89);
  assert.equal(distanceToPopulationArea(point, area), 0);
  assert.equal(matchPopulationArea({ lat: 37.5, lon: 126.986 }, [area]), null);
  assert.deepEqual(near, { lat: 37.5, lon: 126.989 });
});

test('labels actual Jamsil nearby-region data with its source area and measured boundary distance', async () => {
  // Given: the OSM station center lies outside the published population polygons.
  const selected = { lat: 37.5132169, lon: 127.1001365 };
  const match = matchPopulationArea(selected);
  const response = payload({ AREA_CD: match.area.code, AREA_NM: match.area.name });
  const service = new PopulationService({ now: () => now, fetch: async () => Response.json(response) });
  // When: looking up a neighboring source region within the explicit 250m allowance.
  const result = await service.at(selected, 'fixture-key');
  // Then: the source estimate is never described as the queried point's actual population or a model input.
  assert.equal(result.area_relation, 'NEARBY_AREA');
  assert.equal(result.area.name, '잠실 관광특구');
  assert.ok(result.distance_to_area_m > 13 && result.distance_to_area_m < 14);
  assert.match(result.note, /선택한 위치는 이 구역 밖/);
  assert.equal(result.score_included, false);
  assert.deepEqual(selected, { lat: 37.5132169, lon: 127.1001365 });
});

test('parses actual response field names, Korean clock and a valid zero population', () => {
  // Given: the API returns string counts and its documented dotted result code.
  // When: normalizing one complete named area.
  const value = parsePopulation(payload({ AREA_PPLTN_MIN: '0', AREA_PPLTN_MAX: '0' }), area, now.toISOString());
  // Then: zero stays zero, and observed/fetched timestamps remain distinct.
  assert.equal(value.minimum, 0); assert.equal(value.maximum, 0);
  assert.equal(value.observed_at, '2026-11-04T11:55:00.000Z');
  assert.equal(value.fetched_at, now.toISOString());
});

for (const [name, overrides] of [
  ['missing value', { AREA_PPLTN_MIN: '' }], ['null value', { AREA_PPLTN_MAX: null }],
  ['inverted range', { AREA_PPLTN_MIN: '2000' }], ['impossible calendar', { PPLTN_TIME: '2026-02-30 20:55' }],
  ['future observation', { PPLTN_TIME: '2026-11-04 21:05' }],
]) test(`rejects ${name} without turning it into a population estimate`, () => {
  // Given/When/Then: malformed source values cannot cross the boundary as a valid observation.
  assert.throws(() => parsePopulation(payload(overrides), area, now.toISOString()), expectedCode('invalid_source_payload'));
});

test('does not attach a different area or authorization envelope to the selected coordinate', () => {
  // Given/When/Then: matching HTTP transport is insufficient without source identity and authorization.
  assert.throws(() => parsePopulation(payload({ AREA_CD: 'POI999' }), area, now.toISOString()), expectedCode('source_area_mismatch'));
  assert.throws(() => parsePopulation({ RESULT: { CODE: 'ERROR-300' } }, area, now.toISOString()), expectedCode('source_not_authorized'));
});

test('distinguishes fresh estimates, old observations and replacement data', () => {
  // Given: the same real estimate is evaluated at later lookup times.
  const value = observation();
  // When/Then: only the fresh non-replacement observation is eligible as current data.
  assert.equal(populationResult(value, now).status, 'AVAILABLE');
  assert.equal(populationResult(value, new Date('2026-11-04T12:26:00Z')).status, 'STALE');
  assert.equal(populationResult({ ...value, is_replacement: true }, now).status, 'STALE');
});

test('returns uncovered or missing-key states without calling the source', async () => {
  // Given: no source call should occur for unsupported geography or absent credentials.
  let requests = 0;
  const service = new PopulationService({ now: () => now, areas: [area], fetch: async () => { requests++; return Response.json(payload()); } });
  // When/Then: neither no-data case produces invented counts or an external request.
  const outside = await service.at({ lat: 37.9, lon: 127 }, 'fixture-key');
  const missing = await service.at(point, '');
  assert.equal(outside.status, 'NO_COVERAGE'); assert.equal(outside.population_min, null);
  assert.equal(missing.status, 'UNAVAILABLE'); assert.equal(missing.reason, 'api_key_missing');
  assert.equal(requests, 0);
});

test('coalesces concurrent area requests and keeps source data cached for ten minutes', async () => {
  // Given: one area with a successful source, and a mutable test clock.
  let clock = now.getTime(), requests = 0;
  const service = new PopulationService({ now: () => new Date(clock), areas: [area], fetch: async () => { requests++; return Response.json(payload()); } });
  // When: two clicks hit the area together and another click occurs within the cache TTL.
  await Promise.all([service.at(point, 'fixture-key'), service.at(point, 'fixture-key')]);
  clock += 9 * 60000; await service.at(point, 'fixture-key');
  assert.equal(requests, 1);
  // Then: the next explicit lookup after expiry renews the source.
  clock += 2 * 60000; await service.at(point, 'fixture-key'); assert.equal(requests, 2);
});

function persistence(events, initial = null) {
  return {
    read: async () => initial,
    archive: async input => { events.push({ kind: 'archive', input }); return { raw_sha256: 'a'.repeat(64), retrieved_at: input.retrieved_at }; },
    write: async (_code, record, raw, date) => { events.push({ kind: 'write', record, raw }); return { record, raw_sha256: 'a'.repeat(64), retrieved_at: date.toISOString(), expires_at: new Date(date.getTime() + 600000).toISOString(), fresh: true }; },
  };
}

test('archives raw bytes before parsing and only publishes a DB-preserved valid observation', async () => {
  // Given: a persistence adapter records the order of source evidence and normalized publication.
  const events = [];
  const service = new PopulationService({ now: () => now, areas: [area], store: persistence(events), fetch: async () => Response.json(payload()) });
  // When: one source observation is fetched.
  const result = await service.at(point, 'fixture-key');
  // Then: raw and observation writes both precede the successful UI result.
  assert.deepEqual(events.map(e => e.kind), ['archive', 'write']);
  assert.equal(result.status, 'AVAILABLE');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(events[0].input.raw)), payload());
});

test('preserves invalid responses but never writes an observation, and refuses credential-reflecting responses', async () => {
  // Given: malformed data and an unsafe source echo are separate response failures.
  const events = [];
  const invalid = new PopulationService({ now: () => now, areas: [area], store: persistence(events), fetch: async () => new Response('invalid-json') });
  const echoed = new PopulationService({ now: () => now, areas: [area], store: persistence(events), fetch: async () => new Response('fixture-secret') });
  // When/Then: malformed evidence survives; a secret-bearing response never enters raw storage.
  assert.equal((await invalid.at(point, 'fixture-secret')).status, 'UNAVAILABLE');
  assert.equal((await echoed.at(point, 'fixture-secret')).status, 'UNAVAILABLE');
  assert.deepEqual(events.map(e => e.kind), ['archive']);
});

test('does not display a newly fetched number if durable storage fails', async () => {
  // Given: raw archival succeeds but the observation transaction fails.
  const store = { ...persistence([]), write: async () => { throw new Error('fixture storage failure'); } };
  const service = new PopulationService({ now: () => now, areas: [area], store, fetch: async () => Response.json(payload()) });
  // When/Then: the unpersisted estimate cannot become current UI data.
  const result = await service.at(point, 'fixture-key');
  assert.equal(result.status, 'UNAVAILABLE'); assert.equal(result.population_min, null);
});

test('reuses a durable cache across instances and labels expired fallback as past data', async () => {
  // Given: an immutable observation's first fetched time differs from the latest retrieval time.
  const record = { ...observation(), fetched_at: '2026-11-04T11:56:00Z' };
  const entry = { record, retrieved_at: now.toISOString(), expires_at: '2026-11-04T12:10:00Z', raw_sha256: 'a'.repeat(64), fresh: true };
  const cached = new PopulationService({ now: () => now, areas: [area], store: persistence([], entry), fetch: async () => { throw new Error('unexpected source call'); } });
  const expired = new PopulationService({ now: () => now, areas: [area], store: persistence([], { ...entry, fresh: false }), fetch: async () => new Response('source failed', { status: 503 }) });
  // When/Then: fresh storage serves without source traffic; failed refresh cannot relabel old data current.
  assert.equal((await cached.at(point, 'fixture-key')).fetched_at, now.toISOString());
  const fallback = await expired.at(point, 'fixture-key');
  assert.equal(fallback.status, 'STALE'); assert.equal(fallback.reason, 'last_successful_observation');
});

test('rejects missing, blank, nonfinite and invalid coordinate queries', () => {
  // Given/When/Then: external coordinate parsing never treats missing or empty input as zero.
  for (const query of [{ lat: null, lon: '127' }, { lat: '', lon: '127' }, { lat: 'NaN', lon: '127' }, { lat: '91', lon: '127' }]) assert.equal(populationPointSchema.safeParse(query).success, false);
});

test('constructs the population provider request inside the actual Worker runtime', async () => {
  // Given: the real service is bundled with its real official boundaries and parser.
  const compiled = await build({ stdin: { contents: `
    import {PopulationService} from './app/server/population.ts';
    export default {async fetch(){let requested=false;
      const service=new PopulationService({now:()=>new Date('${now.toISOString()}'),areas:${JSON.stringify([area])},fetch:async request=>{requested=request.url.includes('/citydata_ppltn/1/5/');return Response.json(${JSON.stringify(payload())});}});
      return Response.json({result:await service.at(${JSON.stringify(point)},'fixture-only-key'),requested});
    }};
  `, resolveDir: path.resolve('.') }, bundle: true, format: 'esm', platform: 'browser', write: false, target: 'es2022' });
  const mf = new Miniflare({ modules: true, compatibilityDate: '2026-05-15', cf: false, script: compiled.outputFiles[0].text });
  try {
    // When/Then: Worker-compatible request construction preserves the source estimate and timestamp.
    const response = await (await mf.dispatchFetch('https://example.test/')).json();
    assert.equal(response.requested, true); assert.equal(response.result.status, 'AVAILABLE');
    assert.equal(response.result.population_min, 1000);
  } finally { await mf.dispose(); }
});
