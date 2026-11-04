import ky, { HTTPError, NetworkError, ResponseSizeError, TimeoutError } from 'ky';
import { z } from 'zod';

const DEFAULT_ENDPOINT = 'https://photon.komoot.io/api/';
const USER_AGENT = 'SafeNight/1.0 (+https://safenight-seoul-2026.true-tang-8939.chatgpt.site/)';
const CACHE_MS = 24 * 60 * 60 * 1000;
const REQUEST_INTERVAL_MS = 1200;
const querySchema = z.string().normalize().trim().min(2).max(120).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const featureSchema = z.object({
  type: z.literal('Feature'),
  geometry: z.object({ type: z.literal('Point'), coordinates: z.tuple([z.number().finite(), z.number().finite()]) }),
  properties: z.object({
    osm_type: z.enum(['N', 'W', 'R']), osm_id: z.number().int().positive(),
    name: z.string().optional(), osm_key: z.string(), osm_value: z.string(),
    state: z.string().optional(), city: z.string().optional(), district: z.string().optional(), locality: z.string().optional(),
    street: z.string().optional(), housenumber: z.string().optional(), countrycode: z.string().optional(),
  }),
});
const collectionSchema = z.object({ type: z.literal('FeatureCollection'), features: z.array(featureSchema).max(50) });
export type Place = {
  readonly id: string; readonly name: string; readonly address: string;
  readonly lat: number; readonly lon: number; readonly source: 'openstreetmap';
  readonly category: 'station' | 'place';
};
export type PlaceSearchResult = {
  readonly query: string; readonly places: readonly Place[];
  readonly attribution: '© OpenStreetMap contributors'; readonly attribution_url: 'https://www.openstreetmap.org/copyright';
  readonly provider: 'photon'; readonly provider_url: 'https://photon.komoot.io'; readonly search_mode: 'submitted';
};
export type PlaceSearchCode = 'invalid_search_query' | 'invalid_place_search_configuration' | 'place_search_rate_limited' |
  'place_provider_busy' | 'place_provider_unavailable' | 'invalid_place_response';
export class PlaceSearchError extends Error {
  readonly code: PlaceSearchCode;
  constructor(code: PlaceSearchCode) { super(code); this.name = 'PlaceSearchError'; this.code = code; }
}

export function searchQuery(value: unknown): string {
  const parsed = querySchema.safeParse(value);
  if (!parsed.success) throw new PlaceSearchError('invalid_search_query');
  return parsed.data.replace(/\s+/g, ' ');
}

export function insideSeoulSearchBounds(lat: number, lon: number): boolean {
  return 37.41 <= lat && lat <= 37.72 && 126.73 <= lon && lon <= 127.27;
}

function stationIntent(query: string): boolean { return /\S역$/.test(query); }
function normalizedStationName(value: string): string { return value.replace(/\([^)]*\)/g, '').replace(/\s+/g, '').replace(/역$/, ''); }

/** Station intent is handled generically; unqualified station names must not resolve to bus stops. */
export function placeSearchUrl(query: string, endpoint = DEFAULT_ENDPOINT): URL {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new PlaceSearchError('invalid_place_search_configuration'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new PlaceSearchError('invalid_place_search_configuration');
  url.searchParams.set('q', stationIntent(query) ? query.slice(0, -1).trim() : query);
  url.searchParams.set('limit', '10');
  url.searchParams.set('bbox', '126.73,37.41,127.27,37.72');
  url.searchParams.set('lat', '37.5665');
  url.searchParams.set('lon', '126.9780');
  if (stationIntent(query)) url.searchParams.set('osm_tag', 'railway:station');
  return url;
}

/** Preserve actual provider coordinates and labels; no station coordinates are synthesized. */
export function parsePlaces(payload: unknown, query: string): PlaceSearchResult {
  const parsed = collectionSchema.safeParse(payload);
  if (!parsed.success) throw new PlaceSearchError('invalid_place_response');
  const seen = new Set<string>();
  const station = stationIntent(query);
  const places: Place[] = [];
  for (const feature of parsed.data.features) {
    const [lon, lat] = feature.geometry.coordinates;
    const item = feature.properties;
    if (!insideSeoulSearchBounds(lat, lon) || (item.countrycode && item.countrycode.toUpperCase() !== 'KR')) continue;
    if (station && (item.osm_key !== 'railway' || item.osm_value !== 'station')) continue;
    const id = `osm:${item.osm_type}:${item.osm_id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const isStation = item.osm_key === 'railway' && item.osm_value === 'station';
    const label = item.name?.trim() || [item.street, item.housenumber].filter(Boolean).join(' ');
    if (!label) continue;
    const name = isStation && !label.endsWith('역') ? `${label}역` : label;
    const address = [...new Set([item.state, item.city, item.district, item.locality, item.street, item.housenumber].filter(Boolean))].join(' ');
    places.push({ id, name, address, lat, lon, source: 'openstreetmap', category: isStation ? 'station' : 'place' });
  }
  if (station) {
    const expected = normalizedStationName(query);
    places.sort((a, b) => Number(normalizedStationName(b.name) === expected) - Number(normalizedStationName(a.name) === expected));
  }
  return { query, places: places.slice(0, 6), attribution: '© OpenStreetMap contributors', attribution_url: 'https://www.openstreetmap.org/copyright', provider: 'photon', provider_url: 'https://photon.komoot.io', search_mode: 'submitted' };
}

type SearchDependencies = { readonly fetch?: typeof globalThis.fetch; readonly now?: () => number };
type CacheEntry = { readonly expires: number; readonly value: PlaceSearchResult };

/** Small owner-private app cache: mutates bounded entries and coalesces identical submitted searches. */
export class PlaceSearchService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<PlaceSearchResult>>();
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => number;
  private lastRequestAt = Number.NEGATIVE_INFINITY;
  constructor(dependencies: SearchDependencies = {}) { this.fetcher = dependencies.fetch ?? globalThis.fetch; this.now = dependencies.now ?? Date.now; }

  async search(input: unknown, endpoint = DEFAULT_ENDPOINT): Promise<PlaceSearchResult> {
    const query = searchQuery(input);
    const url = placeSearchUrl(query, endpoint);
    const key = url.href;
    const now = this.now();
    const cached = this.cache.get(key);
    if (cached && cached.expires > now) return { ...cached.value, query };
    const running = this.inFlight.get(key);
    if (running) return running;
    if (now - this.lastRequestAt < REQUEST_INTERVAL_MS) throw new PlaceSearchError('place_search_rate_limited');
    this.lastRequestAt = now;
    const operation = this.load(query, url).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, operation);
    return operation;
  }

  private async load(query: string, url: URL): Promise<PlaceSearchResult> {
    try {
      const response = await ky.get(url, { fetch: this.fetcher, retry: 0, timeout: 10000, redirect: 'manual', maxResponseSize: 256 * 1024, headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
      if (response.status !== 200) throw new PlaceSearchError('place_provider_unavailable');
      const result = parsePlaces(await response.json<unknown>(), query);
      if (this.cache.size >= 128) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      this.cache.set(url.href, { value: result, expires: this.now() + CACHE_MS });
      return result;
    } catch (error) {
      if (error instanceof PlaceSearchError) throw error;
      if (error instanceof HTTPError && error.response.status === 429) throw new PlaceSearchError('place_provider_busy');
      if (error instanceof SyntaxError || error instanceof ResponseSizeError) throw new PlaceSearchError('invalid_place_response');
      // Native fetch transports may reject with TypeError before ky can classify a network error.
      if (error instanceof HTTPError || error instanceof NetworkError || error instanceof TimeoutError || error instanceof DOMException || error instanceof TypeError) throw new PlaceSearchError('place_provider_unavailable');
      throw error;
    }
  }
}
