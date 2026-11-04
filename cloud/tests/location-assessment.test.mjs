import assert from 'node:assert/strict';
import test from 'node:test';
import { assessLocation, LocationQueryError, parseLocationQuery } from '../app/server/location-assessment.ts';

const now = new Date('2026-11-04T11:00:00.000Z');
const point = Object.freeze({ lat: 37.5133, lon: 127.1001 });
const observed = '2026-11-04T10:00:00.000Z';
const latOffset = meters => meters / 6371000 * 180 / Math.PI;
function sensor(id, meters, changes = {}) {
  return Object.freeze({
    sensor_id: id, lat: point.lat + latOffset(meters), lon: point.lon,
    observed_at: observed, score: 80, lux: 10, noise_db: 50, status: 'SCORED', ...changes,
  });
}
function close(actual, expected, tolerance = 1e-8) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} is not within ${tolerance} of ${expected}`);
}

test('keeps the requested location and interpolates nearer observations with inverse squared distance', () => {
  // Given: two independently positioned observations at a 1:2 distance ratio.
  const sources = Object.freeze([sensor('near', 100), sensor('far', 200, { score: 20, lux: 50, noise_db: 80, observed_at: '2026-11-04T09:00:00.000Z' })]);
  // When: estimate the requested point from supported nearby sensor estimates.
  const result = assessLocation(point, sources, now);
  // Then: weights are 4:1; the requested point and source observations stay unchanged.
  assert.deepEqual(result.location, point);
  assert.notStrictEqual(result.location, point);
  assert.equal(result.status, 'SCORED');
  close(result.score, 68);
  close(result.lux, 18);
  close(result.noise_db, 56);
  close(result.sensors[0].weight, 0.8);
  close(result.sensors[1].weight, 0.2);
  close(result.sensors.reduce((sum, row) => sum + row.weight, 0), 1);
  assert.equal(result.observed_from, '2026-11-04T09:00:00.000Z');
  assert.equal(result.observed_until, observed);
  assert.equal(result.coverage.sensor_count, 2);
  assert.equal(sources[0].score, 80);
});

test('uses the 25 meter distance floor and preserves genuine zero measurements and scores', () => {
  // Given: one colocated zero-valued observation and another inside the distance floor.
  const sources = [sensor('at-point', 0, { score: 0, lux: 0, noise_db: 0 }), sensor('close-by', 10, { score: 100, lux: 100, noise_db: 100 })];
  // When: aggregate measurements without singular zero-distance weights.
  const result = assessLocation(point, sources, now);
  // Then: both observations contribute equally and nothing is treated as missing.
  assert.equal(result.status, 'SCORED');
  assert.equal(result.score, 50);
  assert.equal(result.lux, 50);
  assert.equal(result.noise_db, 50);
  assert.equal(result.sensors[0].weight, 0.5);
  assert.equal(result.coverage.nearest_sensor_m, 0);
});

test('excludes stale, future, unsupported and missing observations even when a stale cached score is present', () => {
  // Given: several unusable observations near a supported, fresh one.
  const sources = [
    sensor('stale', 10, { observed_at: '2026-11-03T04:59:59.999Z' }),
    sensor('future', 20, { observed_at: '2026-11-04T11:00:00.001Z' }),
    sensor('unsupported', 30, { status: 'UNSUPPORTED' }),
    sensor('missing', 40, { lux: null }),
    sensor('no-score', 50, { score: null }),
    sensor('usable', 200, { score: 61 }),
  ];
  // When: aggregate only current, already supported sensor predictions.
  const result = assessLocation(point, sources, now);
  // Then: invalid observations are counted as nearby but never influence the estimate.
  assert.equal(result.score, 61);
  assert.deepEqual(result.sensors.map(row => row.sensor_id), ['usable']);
  assert.equal(result.coverage.sensor_count, 1);
  assert.equal(result.coverage.nearby_sensor_count, 6);
  close(result.coverage.nearest_sensor_m, 200);
});

test('retains observations exactly at the inclusive thirty hour lifetime boundary', () => {
  // Given: an observation whose age equals, rather than exceeds, thirty hours.
  const source = sensor('boundary', 20, { observed_at: '2026-11-03T05:00:00.000Z' });
  // When: estimate the point at the boundary instant.
  const result = assessLocation(point, [source], now);
  // Then: the observation is still usable.
  assert.equal(result.status, 'SCORED');
  assert.equal(result.score, 80);
});

test('keeps the radius bounded to 1500 meters rather than borrowing a distant sensor', () => {
  // Given: measurements immediately inside and outside the geographic limit.
  const sources = [sensor('inside', 1499.99), sensor('outside', 1500.01, { score: 0 })];
  // When: interpolate this location.
  const result = assessLocation(point, sources, now);
  // Then: only the in-radius observation contributes.
  assert.equal(result.coverage.radius_m, 1500);
  assert.equal(result.coverage.nearby_sensor_count, 1);
  assert.deepEqual(result.sensors.map(row => row.sensor_id), ['inside']);
  assert.equal(result.score, 80);
});

test('limits the estimate to eight nearest usable sensors and resolves equal distances deterministically', () => {
  // Given: reversed input order with twelve equidistant, distinct sensors.
  const sources = Array.from({ length: 12 }, (_, index) => sensor(String(index).padStart(2, '0'), 100, { score: index })).reverse();
  // When: calculate the fixed-size neighboring estimate.
  const result = assessLocation(point, sources, now);
  // Then: only the eight deterministic nearest entries are used.
  assert.deepEqual(result.sensors.map(row => row.sensor_id), ['00', '01', '02', '03', '04', '05', '06', '07']);
  assert.equal(result.coverage.sensor_count, 8);
  assert.equal(result.coverage.nearby_sensor_count, 12);
  close(result.score, 3.5);
});

test('keeps a perfect source estimate inside the score contract despite floating point weight summation', () => {
  // Given: all source estimates equal 100 with unequal distances and non-exact weights.
  const sources = [25, 50, 75, 100, 125, 150, 175, 200].map((meters, index) => sensor(String(index), meters, { score: 100 }));
  // When: aggregate their scores.
  const result = assessLocation(point, sources, now);
  // Then: rounding error cannot produce a score above the public 0-100 range.
  assert.equal(result.status, 'SCORED');
  assert.equal(result.score, 100);
});

for (const [name, sources, expected] of [
  ['no nearby source', [sensor('distant', 1600)], 'NO_NEARBY_OBSERVATIONS'],
  ['no usable source', [sensor('missing', 10, { score: null, status: 'DATA_UNAVAILABLE' })], 'NO_USABLE_OBSERVATIONS'],
]) {
  test(`returns a clear null estimate with ${name}`, () => {
    // Given: source coverage that cannot support a numeric estimate.
    // When: assess the requested point.
    const result = assessLocation(point, sources, now);
    // Then: no synthetic value or fallback location appears.
    assert.equal(result.status, expected);
    assert.equal(result.score, null);
    assert.equal(result.lux, null);
    assert.equal(result.noise_db, null);
    assert.equal(result.observed_from, null);
    assert.equal(result.observed_until, null);
    assert.deepEqual(result.sensors, []);
    assert.deepEqual(result.location, point);
  });
}

test('does not extend Seoul service coverage merely because a sensor fixture exists outside the city', () => {
  // Given: a valid global coordinate outside the service rectangle with a colocated observation.
  const outside = { lat: 35.1, lon: 129.0 };
  // When: request an estimate there.
  const result = assessLocation(outside, [sensor('outside', 0, outside)], now);
  // Then: the result clearly refuses service without a number.
  assert.equal(result.status, 'OUTSIDE_SERVICE_AREA');
  assert.equal(result.score, null);
  assert.deepEqual(result.location, outside);
});

test('parses a simple decimal location query without altering the requested coordinate', () => {
  // Given: the geographic coordinates from a selected place result.
  const params = new URLSearchParams({ lat: '37.5133', lon: '127.1001' });
  // When: cross the HTTP query boundary.
  const parsed = parseLocationQuery(params);
  // Then: the exact numeric location becomes the calculation input.
  assert.deepEqual(parsed, point);
});

for (const query of ['', 'lat=&lon=127.1', 'lat=NaN&lon=127.1', 'lat=91&lon=127.1', 'lat=37.5&lon=181', 'lat=37.5&lat=37.6&lon=127.1', 'lat=37.5&lon=127.1&radius=999999', 'lat=0x25&lon=127.1']) {
  test(`rejects invalid or ambiguous query ${JSON.stringify(query)}`, () => {
    // Given: an invalid query crossing the API boundary.
    const params = new URLSearchParams(query);
    // When / Then: refuse it as a typed input error before querying the database.
    assert.throws(() => parseLocationQuery(params), error => error instanceof LocationQueryError && error.code === 'invalid_location');
  });
}
