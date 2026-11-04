import ky from 'ky';
import { z } from 'zod';
import boundaryData from './data/population-areas.json' with { type: 'json' };

const pair = z.tuple([z.number().finite(), z.number().finite()]).readonly();
const areaSchema = z.object({ code: z.string().regex(/^POI\d{3}$/), name: z.string().min(1), category: z.string(), bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).readonly(), rings: z.array(z.array(pair).min(4).readonly()).min(1).readonly() }).readonly();
const boundaries = z.object({ source_url: z.url(), source_published_at: z.string().nullable(), areas: z.array(areaSchema).min(1).max(300).readonly() }).parse(boundaryData);
export type PopulationArea = z.infer<typeof areaSchema>;
export type PopulationPoint = { readonly lat: number; readonly lon: number };
const coordinate = z.string().trim().regex(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/).transform(Number).pipe(z.number().finite());
export const populationPointSchema = z.object({ lat: coordinate.pipe(z.number().min(-90).max(90)), lon: coordinate.pipe(z.number().min(-180).max(180)) }).readonly();
const integer = z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/).transform(Number)]).pipe(z.number().int().nonnegative().max(10000000));
const rowSchema = z.object({ AREA_NM: z.string(), AREA_CD: z.string(), AREA_PPLTN_MIN: integer, AREA_PPLTN_MAX: integer, AREA_CONGEST_LVL: z.string().min(1).max(30), PPLTN_TIME: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/), REPLACE_YN: z.enum(['Y', 'N']) });
const envelopeSchema = z.object({ 'SeoulRtd.citydata_ppltn': z.array(rowSchema).optional(), RESULT: z.object({ 'RESULT.CODE': z.string().optional(), CODE: z.string().optional() }).optional() });
const CACHE_MS = 10 * 60 * 1000;
const FRESH_MS = 30 * 60 * 1000;
const SOURCE = { source: '서울시 실시간 인구데이터', source_url: 'https://data.seoul.go.kr/dataList/OA-21778/A/1/datasetView.do', source_update_minutes: 5, cache_minutes: 10, metric: 'area_present_population_estimate', score_included: false, boundary_source_url: boundaries.source_url, boundary_published_at: boundaries.source_published_at } as const;
type AreaLabel = Pick<PopulationArea, 'code' | 'name' | 'category'>;
type PopulationCode = 'source_not_authorized' | 'source_unavailable' | 'invalid_source_payload' | 'source_area_mismatch' | 'population_storage_unavailable' | 'request_throttled';
export class PopulationError extends Error {
  readonly code: PopulationCode;
  constructor(code: PopulationCode) { super(code); this.name = 'PopulationError'; this.code = code; }
}
export type PopulationResult = typeof SOURCE & {
  readonly status: 'AVAILABLE' | 'STALE' | 'NO_COVERAGE' | 'UNAVAILABLE';
  readonly area: AreaLabel | null; readonly population_min: number | null; readonly population_max: number | null;
  readonly congestion: string | null; readonly observed_at: string | null; readonly fetched_at: string | null;
  readonly is_replacement: boolean | null; readonly reason: string; readonly note: string;
  readonly area_relation: 'CONTAINS' | 'NEARBY_AREA' | null; readonly distance_to_area_m: number | null;
};
export type PopulationObservation = { readonly area: AreaLabel; readonly minimum: number; readonly maximum: number; readonly congestion: string; readonly observed_at: string; readonly fetched_at: string; readonly is_replacement: boolean };
export type PopulationSnapshot = { readonly record: PopulationObservation; readonly raw_sha256: string; readonly retrieved_at: string; readonly expires_at: string; readonly fresh: boolean };
export interface PopulationPersistence {
  acquire?(areaCode: string, now: Date): Promise<string | null>;
  release?(areaCode: string, token: string, now: Date): Promise<void>;
  read(areaCode: string, now: Date): Promise<PopulationSnapshot | null>;
  archive(input: { readonly area_code: string; readonly raw: Uint8Array; readonly http_status: number; readonly retrieved_at: string }): Promise<{ readonly raw_sha256: string; readonly retrieved_at: string }>;
  write(areaCode: string, record: PopulationObservation, raw: Uint8Array, now: Date): Promise<PopulationSnapshot>;
}
type PopulationFailure = { readonly area: AreaLabel; readonly reason: PopulationCode | 'api_key_missing'; readonly fetched_at: string };
type StoredPopulation = { readonly kind: 'observation'; readonly value: PopulationObservation } | { readonly kind: 'failure'; readonly value: PopulationFailure };

/** Even/odd ring containment supports disjoint parts and holes; nearby-area matching is handled separately. */
export function insidePopulationArea(point: PopulationPoint, area: PopulationArea): boolean {
  const { lon: x, lat: y } = point;
  const [west, south, east, north] = area.bbox;
  if (x < west || x > east || y < south || y > north) return false;
  let inside = false;
  for (const ring of area.rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, ay] = ring[j], [bx, by] = ring[i];
      const cross = (x - ax) * (by - ay) - (y - ay) * (bx - ax);
      if (Math.abs(cross) < 1e-10 && Math.min(ax, bx) - 1e-10 <= x && x <= Math.max(ax, bx) + 1e-10 && Math.min(ay, by) - 1e-10 <= y && y <= Math.max(ay, by) + 1e-10) return true;
      if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
    }
  }
  return inside;
}

export function findPopulationArea(point: PopulationPoint, areas: readonly PopulationArea[] = boundaries.areas): PopulationArea | null {
  const covering = areas.filter(area => insidePopulationArea(point, area));
  // Prefer the most local published region when a station area overlaps a larger tourism district.
  covering.sort((a, b) => (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]) - (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]) || a.code.localeCompare(b.code));
  return covering[0] ?? null;
}

type AreaMatch = { readonly area: PopulationArea; readonly area_relation: 'CONTAINS' | 'NEARBY_AREA'; readonly distance_to_area_m: number };
const RADIUS = 6371000;
function radians(value: number): number { return value * Math.PI / 180; }
function angularDistance(a: PopulationPoint, b: PopulationPoint): number {
  const term = Math.sin(radians(b.lat - a.lat) / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(radians(b.lon - a.lon) / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(term)));
}
function bearing(a: PopulationPoint, b: PopulationPoint): number {
  const difference = radians(b.lon - a.lon);
  return Math.atan2(Math.sin(difference) * Math.cos(radians(b.lat)), Math.cos(radians(a.lat)) * Math.sin(radians(b.lat)) - Math.sin(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.cos(difference));
}

/** Great-circle segment distance measures the actual published boundary, never its centroid. */
export function distanceToPopulationArea(point: PopulationPoint, area: PopulationArea): number {
  if (insidePopulationArea(point, area)) return 0;
  let nearest = Number.POSITIVE_INFINITY;
  for (const ring of area.rings) for (let i = 1; i < ring.length; i++) {
    const a = { lon: ring[i - 1][0], lat: ring[i - 1][1] }, b = { lon: ring[i][0], lat: ring[i][1] };
    const length = angularDistance(a, b), distance = angularDistance(a, point), angle = bearing(a, point) - bearing(a, b);
    const along = Math.atan2(Math.sin(distance) * Math.cos(angle), Math.cos(distance));
    const cross = Math.abs(Math.asin(Math.max(-1, Math.min(1, Math.sin(distance) * Math.sin(angle)))));
    nearest = Math.min(nearest, length > 0 && along >= 0 && along <= length ? cross : Math.min(distance, angularDistance(b, point)));
  }
  return nearest * RADIUS;
}

export function matchPopulationArea(point: PopulationPoint, areas: readonly PopulationArea[] = boundaries.areas): AreaMatch | null {
  const contained = findPopulationArea(point, areas);
  if (contained) return { area: contained, area_relation: 'CONTAINS', distance_to_area_m: 0 };
  const nearby = areas.map(area => ({ area, area_relation: 'NEARBY_AREA' as const, distance_to_area_m: distanceToPopulationArea(point, area) })).filter(match => match.distance_to_area_m <= 250);
  nearby.sort((a, b) => a.distance_to_area_m - b.distance_to_area_m || a.area.code.localeCompare(b.area.code));
  return nearby[0] ?? null;
}

function related(result: PopulationResult, match: AreaMatch): PopulationResult {
  return { ...result, area_relation: match.area_relation, distance_to_area_m: match.distance_to_area_m, note: match.area_relation === 'NEARBY_AREA' ? `선택한 위치는 이 구역 밖이며, 경계까지 ${Math.round(match.distance_to_area_m)}m인 인근 구역의 참고값입니다. ${result.note}` : result.note };
}

function areaLabel(area: PopulationArea): AreaLabel { return { code: area.code, name: area.name, category: area.category }; }
function unavailable(area: AreaLabel | null, reason: string, fetched_at: string | null): PopulationResult {
  return { ...SOURCE, status: area ? 'UNAVAILABLE' : 'NO_COVERAGE', area, population_min: null, population_max: null, congestion: null, observed_at: null, fetched_at, is_replacement: null, reason, area_relation: area ? 'CONTAINS' : null, distance_to_area_m: area ? 0 : null, note: area ? '이 구역의 인구 자료를 확인하지 못했습니다. 숫자를 임의로 채우지 않습니다.' : '선택한 위치와 250m 이내에 서울시 공개 인구 집계 구역이 없습니다.' };
}

/** Validate the exact region, numeric range and Korean observation clock before using source data. */
export function parsePopulation(payload: unknown, area: PopulationArea, fetched_at: string): PopulationObservation {
  const parsed = envelopeSchema.safeParse(payload);
  if (!parsed.success) throw new PopulationError('invalid_source_payload');
  const code = parsed.data.RESULT?.['RESULT.CODE'] ?? parsed.data.RESULT?.CODE;
  if (code === 'ERROR-300' || code === 'INFO-100') throw new PopulationError('source_not_authorized');
  if (code !== 'INFO-000') throw new PopulationError('source_unavailable');
  const rows = parsed.data['SeoulRtd.citydata_ppltn'];
  if (!rows || rows.length !== 1) throw new PopulationError('invalid_source_payload');
  const row = rows[0];
  if (row.AREA_CD !== area.code || row.AREA_NM.trim() !== area.name) throw new PopulationError('source_area_mismatch');
  const local = row.PPLTN_TIME.replace(' ', 'T') + (row.PPLTN_TIME.length === 16 ? ':00' : '');
  const milliseconds = Date.parse(`${local}+09:00`);
  if (!Number.isFinite(milliseconds) || milliseconds > Date.parse(fetched_at) || new Date(milliseconds + 9 * 3600000).toISOString().slice(0, 19) !== local || row.AREA_PPLTN_MIN > row.AREA_PPLTN_MAX) throw new PopulationError('invalid_source_payload');
  return { area: areaLabel(area), minimum: row.AREA_PPLTN_MIN, maximum: row.AREA_PPLTN_MAX, congestion: row.AREA_CONGEST_LVL, observed_at: new Date(milliseconds).toISOString(), fetched_at, is_replacement: row.REPLACE_YN === 'Y' };
}

export function populationResult(observation: PopulationObservation, now: Date): PopulationResult {
  const age = now.getTime() - Date.parse(observation.observed_at);
  if (!Number.isFinite(age) || age < 0) return unavailable(observation.area, 'source_clock_error', observation.fetched_at);
  const stale = age > FRESH_MS || observation.is_replacement;
  return { ...SOURCE, status: stale ? 'STALE' : 'AVAILABLE', area: observation.area, population_min: observation.minimum, population_max: observation.maximum, congestion: observation.congestion, observed_at: observation.observed_at, fetched_at: observation.fetched_at, is_replacement: observation.is_replacement, reason: observation.is_replacement ? 'replacement_data' : stale ? 'observation_stale' : 'live', area_relation: 'CONTAINS', distance_to_area_m: 0, note: observation.is_replacement ? '원천에서 대체 데이터로 표시한 구역 추정치입니다. 현재 집계로 사용하지 않습니다.' : stale ? '관측 시각이 30분을 넘어 지난 자료입니다. 현재 인구로 해석하지 마세요.' : '통신사 기지국 신호를 바탕으로 추정한 구역 전체의 현재 인구입니다. 분당 통과 인원이나 지점의 실제 인원수가 아닙니다.' };
}

type PopulationDependencies = { readonly fetch?: typeof globalThis.fetch; readonly now?: () => Date; readonly areas?: readonly PopulationArea[]; readonly store?: PopulationPersistence };
/** Mutates a bounded ten-minute source cache and coalesces simultaneous requests per actual area. */
export class PopulationService {
  private readonly cache = new Map<string, { readonly expires: number; readonly value: StoredPopulation }>();
  private readonly inFlight = new Map<string, Promise<StoredPopulation>>();
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => Date;
  private readonly areas: readonly PopulationArea[];
  private readonly store: PopulationPersistence | undefined;
  constructor(dependencies: PopulationDependencies = {}) { this.fetcher = dependencies.fetch ?? globalThis.fetch; this.now = dependencies.now ?? (() => new Date()); this.areas = dependencies.areas ?? boundaries.areas; this.store = dependencies.store; }

  async at(point: PopulationPoint, apiKey: string): Promise<PopulationResult> {
    const match = matchPopulationArea(point, this.areas);
    if (!match) return unavailable(null, 'outside_published_areas', null);
    const { area } = match;
    const now = this.now();
    let previous: PopulationObservation | null = null;
    if (this.store) {
      try {
        const snapshot = await this.store.read(area.code, now);
        if (snapshot?.fresh) return related(populationResult({ ...snapshot.record, fetched_at: snapshot.retrieved_at }, now), match);
        previous = snapshot ? { ...snapshot.record, fetched_at: snapshot.retrieved_at } : null;
      } catch { return related(unavailable(areaLabel(area), 'population_storage_unavailable', now.toISOString()), match); }
    }
    const cached = this.cache.get(area.code);
    const stored = cached && cached.expires > now.getTime() ? cached.value : await (this.inFlight.get(area.code) ?? this.start(area, apiKey));
    switch (stored.kind) {
      case 'observation': return related(populationResult(stored.value, this.now()), match);
      case 'failure': return related(previous ? { ...populationResult(previous, now), status: 'STALE', reason: 'last_successful_observation', note: '새 인구 자료 조회에 실패해 DB에 보존된 지난 집계를 표시합니다. 현재 인구로 사용하지 않습니다.' } : unavailable(stored.value.area, stored.value.reason, stored.value.fetched_at), match);
      default: return unreachable(stored);
    }
  }

  private start(area: PopulationArea, apiKey: string): Promise<StoredPopulation> {
    const operation = this.load(area, apiKey).then(value => { this.cache.set(area.code, { expires: this.now().getTime() + CACHE_MS, value }); return value; }).finally(() => this.inFlight.delete(area.code));
    this.inFlight.set(area.code, operation);
    return operation;
  }

  private async load(area: PopulationArea, apiKey: string): Promise<StoredPopulation> {
    let fetched_at = this.now().toISOString();
    if (!apiKey.trim()) return { kind: 'failure', value: { area: areaLabel(area), reason: 'api_key_missing', fetched_at } };
    const token = this.store?.acquire ? await this.store.acquire(area.code, this.now()) : undefined;
    if (token === null) {
      const current = await this.store?.read(area.code, this.now());
      return current ? { kind: 'observation', value: current.record }
        : { kind: 'failure', value: { area: areaLabel(area), reason: 'request_throttled', fetched_at } };
    }
    try {
      const response = await this.request(area, apiKey);
      fetched_at = this.now().toISOString();
      const text = new TextDecoder().decode(response.body);
      if (text.includes(apiKey)) throw new PopulationError('invalid_source_payload');
      if (this.store) {
        try { await this.store.archive({ area_code: area.code, raw: response.body, http_status: response.status, retrieved_at: fetched_at }); }
        catch { throw new PopulationError('population_storage_unavailable'); }
      }
      if (response.status === 401 || response.status === 403) throw new PopulationError('source_not_authorized');
      if (response.status !== 200) throw new PopulationError('source_unavailable');
      let payload: unknown;
      try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body)); }
      catch { throw new PopulationError('invalid_source_payload'); }
      const observation = parsePopulation(payload, area, fetched_at);
      if (this.store) {
        try {
          const saved = await this.store.write(area.code, observation, response.body, new Date(fetched_at));
          return { kind: 'observation', value: { ...saved.record, fetched_at: saved.retrieved_at } };
        }
        catch { throw new PopulationError('population_storage_unavailable'); }
      }
      return { kind: 'observation', value: observation };
    } catch (error) {
      if (error instanceof PopulationError) return { kind: 'failure', value: { area: areaLabel(area), reason: error.code, fetched_at } };
      throw error;
    } finally { if (token) await this.store?.release?.(area.code, token, this.now()); }
  }

  private async request(area: PopulationArea, apiKey: string): Promise<{ readonly body: Uint8Array; readonly status: number }> {
    const url = `http://openapi.seoul.go.kr:8088/${encodeURIComponent(apiKey)}/json/citydata_ppltn/1/5/${encodeURIComponent(area.name)}`;
    try {
      const response = await ky.get(url, { fetch: this.fetcher, retry: 0, timeout: 10000, redirect: 'manual', maxResponseSize: 256 * 1024, throwHttpErrors: false });
      return { body: new Uint8Array(await response.arrayBuffer()), status: response.status };
    } catch (error) {
      if (error instanceof PopulationError) throw error;
      // This external request boundary must never propagate a credential-bearing URL or response exception.
      throw new PopulationError(error instanceof SyntaxError ? 'invalid_source_payload' : 'source_unavailable');
    }
  }
}

function unreachable(value: never): never { throw new TypeError(`Unexpected population cache state: ${String(value)}`); }
