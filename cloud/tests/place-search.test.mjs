import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { parsePlaces, PlaceSearchError, PlaceSearchService, placeSearchUrl, searchQuery } from '../app/server/place-search.ts';

const station = (overrides = {}) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [127.1001365, 37.5132169] }, properties: { osm_type: 'N', osm_id: 6033315017, osm_key: 'railway', osm_value: 'station', name: '잠실', city: '서울특별시', district: '잠실6동', street: '올림픽로', housenumber: '지하265', countrycode: 'KR' }, ...overrides });
const collection = features => ({ type: 'FeatureCollection', features });
const code = expected => error => error instanceof PlaceSearchError && error.code === expected;

test('normalizes submitted query whitespace while rejecting unbounded and control-character input', () => {
  // Given/When/Then: user text is parsed before it can become an external request.
  assert.equal(searchQuery('  잠실역  '), '잠실역');
  assert.equal(searchQuery('서울시  송파구'), '서울시 송파구');
  for (const value of [null, '', '역', 'a'.repeat(121), '잠실\u0000역']) assert.throws(() => searchQuery(value), code('invalid_search_query'));
});

test('searches station intent with a railway filter instead of accepting a same-name bus stop', () => {
  // Given: an arbitrary station-suffixed query, not a per-station coordinate lookup.
  const url = placeSearchUrl('잠실역');
  // When/Then: the source receives the station name and category constraint.
  assert.equal(url.searchParams.get('q'), '잠실');
  assert.equal(url.searchParams.get('osm_tag'), 'railway:station');
  assert.equal(url.searchParams.get('bbox'), '126.73,37.41,127.27,37.72');
  assert.equal(placeSearchUrl('올림픽로 300').searchParams.get('osm_tag'), null);
});

test('preserves actual source coordinates and ranks exact station before similarly named stations', () => {
  // Given: actual-shaped Jamsil metadata and a similarly named station ahead of it.
  const similar = station({ properties: { ...station().properties, osm_id: 6033315010, name: '잠실새내' } });
  // When: parsing the source result.
  const result = parsePlaces(collection([similar, station()]), '잠실역');
  // Then: matching is semantic, and the selected coordinate is the provider's original point.
  assert.deepEqual(result.places[0], { id: 'osm:N:6033315017', name: '잠실역', address: '서울특별시 잠실6동 올림픽로 지하265', lat: 37.5132169, lon: 127.1001365, source: 'openstreetmap', category: 'station' });
  assert.equal(result.attribution, '© OpenStreetMap contributors');
});

test('filters wrong-country, outside-service, duplicate and wrong-category results without inventing replacements', () => {
  // Given: untrusted provider records include unusable points and duplicate IDs.
  const outside = station({ geometry: { type: 'Point', coordinates: [129.0756, 35.1796] } });
  const bus = station({ properties: { ...station().properties, osm_key: 'highway', osm_value: 'bus_stop' } });
  const wrongCountry = station({ properties: { ...station().properties, countrycode: 'JP' } });
  // When/Then: only one valid actual station is returned; no-data remains an empty list.
  assert.equal(parsePlaces(collection([outside, bus, wrongCountry, station(), station()]), '잠실역').places.length, 1);
  assert.deepEqual(parsePlaces(collection([outside, bus]), '잠실역').places, []);
});

test('rejects malformed provider shapes and coordinates', () => {
  // Given/When/Then: a successful HTTP response does not bypass the data boundary.
  for (const payload of [null, [], { type: 'FeatureCollection', features: [station({ geometry: { type: 'Point', coordinates: ['127', '37'] } })] }]) assert.throws(() => parsePlaces(payload, '잠실역'), code('invalid_place_response'));
});

test('does not duplicate a station suffix already present in the source label', () => {
  // Given/When/Then: Seoul station is named 서울역 by the provider.
  const result = parsePlaces(collection([station({ properties: { ...station().properties, name: '서울역' } })]), '서울역');
  assert.equal(result.places[0].name, '서울역');
});

test('preserves named shops and unnamed address points without guessing a building name', () => {
  // Given: address search results can identify a shop or only a street and number.
  const shop = station({ properties: { ...station().properties, state: '서울특별시', city: '송파구', name: '실제 상호', osm_key: 'shop', osm_value: 'hairdresser' } });
  const address = station({ properties: { ...station().properties, osm_id: 12, name: undefined, osm_key: 'building', osm_value: 'yes', street: '올림픽로', housenumber: '300' } });
  // When: parsing a general submitted address query.
  const result = parsePlaces(collection([shop, address]), '송파구 올림픽로 300');
  // Then: labels and coordinates come only from the actual source fields.
  assert.equal(result.places[0].name, '실제 상호');
  assert.match(result.places[0].address, /서울특별시 송파구/);
  assert.equal(result.places[1].name, '올림픽로 300');
  assert.equal(result.places[1].category, 'place');
});

test('does not treat malformed JSON or a source network failure as empty search results', async () => {
  // Given: the source returns malformed data or fails before producing a response.
  const invalid = new PlaceSearchService({ fetch: async () => new Response('not-json', { status: 200 }) });
  const offline = new PlaceSearchService({ fetch: async () => { throw new TypeError('fixture network failure'); } });
  // When/Then: callers receive typed failures, with no invented result or frozen cache.
  await assert.rejects(() => invalid.search('잠실역'), code('invalid_place_response'));
  await assert.rejects(() => offline.search('잠실역'), code('place_provider_unavailable'));
});

test('reuses same-query cache without another provider request', async () => {
  // Given: a successful search source and a new application cache.
  let requests = 0;
  const service = new PlaceSearchService({ fetch: async () => { requests++; return Response.json(collection([station()])); }, now: () => 10000 });
  // When: the same normalized query is submitted again.
  await service.search('잠실역');
  const repeated = await service.search(' 잠실역 ');
  // Then: a real parsed result is reused without external traffic.
  assert.equal(requests, 1); assert.equal(repeated.places[0].name, '잠실역');
});

test('coalesces in-flight identical searches and rejects different-query bursts', async () => {
  // Given: one source request remains pending.
  let finish;
  let requests = 0;
  const service = new PlaceSearchService({ fetch: () => { requests++; return new Promise(resolve => { finish = resolve; }); }, now: () => 10000 });
  const first = service.search('잠실역');
  const same = service.search('잠실역');
  // When: a separate source request would exceed the isolate's request interval.
  await assert.rejects(() => service.search('강남역'), code('place_search_rate_limited'));
  finish(Response.json(collection([station()])));
  // Then: identical requests share one response; no burst reached the provider.
  assert.deepEqual(await first, await same); assert.equal(requests, 1);
});

test('expires cache instead of serving a permanently frozen place result', async () => {
  // Given: the cached result is more than a day old.
  let now = 10000;
  let requests = 0;
  const service = new PlaceSearchService({ fetch: async () => { requests++; return Response.json(collection([station()])); }, now: () => now });
  await service.search('잠실역');
  now += 24 * 60 * 60 * 1000 + 1;
  // When: the next explicit search runs.
  await service.search('잠실역');
  // Then: source lookup is renewed.
  assert.equal(requests, 2);
});

for (const [status, expected] of [[302, 'place_provider_unavailable'], [429, 'place_provider_busy'], [503, 'place_provider_unavailable']]) test(`returns a typed provider failure for HTTP ${status}`, async () => {
  // Given: a failed or redirecting source response.
  const service = new PlaceSearchService({ fetch: async () => new Response(null, { status }) });
  // When/Then: it is never cached or presented as a successful empty search.
  await assert.rejects(() => service.search('잠실역'), code(expected));
});

test('permits provider endpoint replacement but never accepts non-HTTPS or credential-bearing configuration', () => {
  // Given/When/Then: the application operator can replace a Photon-compatible service safely.
  assert.equal(placeSearchUrl('강남역', 'https://places.example.test/api/').hostname, 'places.example.test');
  for (const endpoint of ['http://places.example.test/api/', 'https://user:secret@places.example.test/api/', 'https://places.example.test/api/?token=secret']) assert.throws(() => placeSearchUrl('강남역', endpoint), code('invalid_place_search_configuration'));
});

test('constructs the configured Photon request in the actual Worker runtime', async () => {
  // Given: the actual bundled search implementation runs under Workers, not Node fetch mocks alone.
  const compiled = await build({ stdin: { contents: `
    import {PlaceSearchService} from './app/server/place-search.ts';
    export default {async fetch(){let target=null;let agent=null;
      const service=new PlaceSearchService({fetch:async request=>{
        target=request.url;agent=request.headers.get('User-Agent');
        return Response.json(${JSON.stringify(collection([station()]))});
      }});
      return Response.json({result:await service.search('잠실역'),target,agent});
    }};
  `, resolveDir: path.resolve('.') }, bundle: true, format: 'esm', platform: 'browser', write: false, target: 'es2022' });
  const mf = new Miniflare({ modules: true, compatibilityDate: '2026-05-15', cf: false, script: compiled.outputFiles[0].text });
  try {
    // When: a submitted search is handled in the Worker isolate.
    const response = await (await mf.dispatchFetch('https://example.test/')).json();
    // Then: it preserves the real point and applies station intent, identification and bounded geography.
    assert.equal(response.result.places[0].lat, 37.5132169);
    assert.equal(new URL(response.target).searchParams.get('osm_tag'), 'railway:station');
    assert.match(response.agent, /SafeNight/);
  } finally { await mf.dispose(); }
});
