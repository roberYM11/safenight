import { z } from 'zod';
import { distanceMeters } from './forest.ts';

const RADIUS_METERS = 1500;
const MAX_SENSORS = 8;
const MIN_DISTANCE_METERS = 25;
const MAX_AGE_MILLISECONDS = 30 * 60 * 60 * 1000;
const coordinate = z.string().trim().regex(/^-?(?:\d+(?:\.\d+)?|\.\d+)$/).transform(Number);
const querySchema = z.object({
  lat: coordinate.pipe(z.number().finite().min(-90).max(90)),
  lon: coordinate.pipe(z.number().finite().min(-180).max(180)),
}).strict().readonly();

export type LocationPoint = { readonly lat: number; readonly lon: number };
export type LocationSensor = LocationPoint & {
  readonly sensor_id: string; readonly observed_at: string;
  readonly score: number | null; readonly lux: number | null; readonly noise_db: number | null;
  readonly status: string;
};
export type LocationStatus = 'SCORED' | 'NO_NEARBY_OBSERVATIONS' | 'NO_USABLE_OBSERVATIONS' | 'OUTSIDE_SERVICE_AREA';
export type WeightedSensor = LocationPoint & {
  readonly sensor_id: string; readonly observed_at: string; readonly distance_m: number; readonly weight: number;
  readonly score: number; readonly lux: number; readonly noise_db: number;
};
export type LocationAssessment = {
  readonly location: LocationPoint; readonly status: LocationStatus;
  readonly score: number | null; readonly lux: number | null; readonly noise_db: number | null;
  readonly assessed_at: string; readonly observed_from: string | null; readonly observed_until: string | null;
  readonly method: 'inverse-distance-squared-v1';
  readonly coverage: {
    readonly radius_m: number; readonly sensor_count: number; readonly nearby_sensor_count: number;
    readonly nearest_sensor_m: number | null;
  };
  readonly sensors: readonly WeightedSensor[];
};
type NearbySensor = { readonly sensor: LocationSensor; readonly distance_m: number };
type UsableSensor = LocationSensor & { readonly score: number; readonly lux: number; readonly noise_db: number };
type UsableNearbySensor = { readonly sensor: UsableSensor; readonly distance_m: number };

export class LocationQueryError extends Error {
  readonly code = 'invalid_location';
  constructor() { super('invalid_location'); this.name = 'LocationQueryError'; }
}

/** Reject missing, duplicated, unknown or non-decimal query parameters. */
export function parseLocationQuery(params: URLSearchParams): LocationPoint {
  if (params.getAll('lat').length !== 1 || params.getAll('lon').length !== 1) throw new LocationQueryError();
  const result = querySchema.safeParse(Object.fromEntries(params));
  if (!result.success) throw new LocationQueryError();
  return result.data;
}

/** Rectangular service boundary; nearby observations still determine actual coverage. */
function withinSeoul(point: LocationPoint): boolean {
  return point.lat >= 37.4 && point.lat <= 37.72 && point.lon >= 126.73 && point.lon <= 127.27;
}

function usable(sensor: LocationSensor, now: number): sensor is UsableSensor {
  const observed = Date.parse(sensor.observed_at);
  return sensor.status === 'SCORED'
    && Number.isFinite(observed) && observed <= now && now - observed <= MAX_AGE_MILLISECONDS
    && sensor.score !== null && Number.isFinite(sensor.score) && sensor.score >= 0 && sensor.score <= 100
    && sensor.lux !== null && Number.isFinite(sensor.lux) && sensor.lux >= 0
    && sensor.noise_db !== null && Number.isFinite(sensor.noise_db) && sensor.noise_db >= 0 && sensor.noise_db <= 200;
}

/** Interpolate existing supported sensor estimates, never move or infer a new RF input at the requested point. */
export function assessLocation(point: LocationPoint, sensors: readonly LocationSensor[], now = new Date()): LocationAssessment {
  const assessedAt = now.toISOString();
  const location = { lat: point.lat, lon: point.lon };
  const method: LocationAssessment['method'] = 'inverse-distance-squared-v1';
  const base = {
    location, assessed_at: assessedAt, method,
    score: null, lux: null, noise_db: null, observed_from: null, observed_until: null,
    coverage: { radius_m: RADIUS_METERS, sensor_count: 0, nearby_sensor_count: 0, nearest_sensor_m: null },
    sensors: [],
  };
  if (!withinSeoul(point)) return { ...base, status: 'OUTSIDE_SERVICE_AREA' };
  const nearby: NearbySensor[] = sensors
    .map(sensor => ({ sensor, distance_m: distanceMeters(point.lat, point.lon, sensor.lat, sensor.lon) }))
    .filter(row => Number.isFinite(row.distance_m) && row.distance_m <= RADIUS_METERS)
    .sort((left, right) => left.distance_m - right.distance_m || (left.sensor.sensor_id < right.sensor.sensor_id ? -1 : left.sensor.sensor_id > right.sensor.sensor_id ? 1 : 0));
  if (nearby.length === 0) return { ...base, status: 'NO_NEARBY_OBSERVATIONS' };
  const chosen = nearby.filter((row): row is UsableNearbySensor => usable(row.sensor, now.getTime())).slice(0, MAX_SENSORS);
  if (chosen.length === 0) return {
    ...base, status: 'NO_USABLE_OBSERVATIONS',
    coverage: { ...base.coverage, nearby_sensor_count: nearby.length, nearest_sensor_m: nearby[0].distance_m },
  };
  const rawWeights = chosen.map(row => 1 / Math.max(MIN_DISTANCE_METERS, row.distance_m) ** 2);
  const totalWeight = rawWeights.reduce((sum, weight) => sum + weight, 0);
  const weighted: WeightedSensor[] = chosen.map((row, index) => {
    const sensor = row.sensor;
    return {
      sensor_id: sensor.sensor_id, lat: sensor.lat, lon: sensor.lon, observed_at: sensor.observed_at,
      distance_m: row.distance_m, weight: rawWeights[index] / totalWeight,
      score: sensor.score, lux: sensor.lux, noise_db: sensor.noise_db,
    };
  });
  const timestamps = weighted.map(sensor => Date.parse(sensor.observed_at));
  return {
    ...base, status: 'SCORED',
    score: Math.min(100, Math.max(0, weighted.reduce((sum, sensor) => sum + sensor.weight * sensor.score, 0))),
    lux: weighted.reduce((sum, sensor) => sum + sensor.weight * sensor.lux, 0),
    noise_db: weighted.reduce((sum, sensor) => sum + sensor.weight * sensor.noise_db, 0),
    observed_from: new Date(Math.min(...timestamps)).toISOString(),
    observed_until: new Date(Math.max(...timestamps)).toISOString(),
    coverage: { radius_m: RADIUS_METERS, sensor_count: weighted.length, nearby_sensor_count: nearby.length, nearest_sensor_m: weighted[0].distance_m },
    sensors: weighted,
  };
}
