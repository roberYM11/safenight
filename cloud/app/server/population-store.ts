import { z } from 'zod';
import { canonicalJson, sha256 } from './cloud/contracts.ts';

const SOURCE_URL = 'https://data.seoul.go.kr/dataList/OA-21778/A/1/datasetView.do';
const CACHE_MILLISECONDS = 10 * 60 * 1000;
const MAX_RAW_BYTES = 1024 * 1024;
const areaCode = z.string().regex(/^POI\d{3}$/);
const timestamp = z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString());
const population = z.number().int().nonnegative().max(10000000);
const observationSchema = z.object({
  area: z.object({ code: areaCode, name: z.string().min(1).max(200), category: z.string().max(100) }).strict().readonly(),
  minimum: population, maximum: population, congestion: z.string().min(1).max(30),
  observed_at: timestamp, fetched_at: timestamp, is_replacement: z.boolean(),
  source_url: z.literal(SOURCE_URL).default(SOURCE_URL),
}).strict().readonly().refine(row => row.minimum <= row.maximum);
const rawRequestSchema = z.object({ area_code: areaCode, http_status: z.number().int().min(100).max(599), retrieved_at: timestamp }).strict();
const cacheRowSchema = z.object({
  payload_json: z.string(), raw_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  retrieved_at: timestamp, expires_at: timestamp,
});
export type PopulationStoredObservation = z.infer<typeof observationSchema>;
export type PopulationCacheEntry = {
  readonly record: PopulationStoredObservation; readonly raw_sha256: string;
  readonly retrieved_at: string; readonly expires_at: string; readonly fresh: boolean;
};
export type PopulationRawRequest = {
  readonly area_code: string; readonly raw: Uint8Array; readonly http_status: number; readonly retrieved_at: string;
};
type PopulationStoreCode = 'invalid_population_record' | 'population_area_mismatch' | 'population_raw_size_exceeded' | 'population_cache_missing';
export class PopulationStoreError extends Error {
  readonly code: PopulationStoreCode;
  constructor(code: PopulationStoreCode) { super(code); this.name = 'PopulationStoreError'; this.code = code; }
}

/** Store only public area-level aggregates; no user coordinate or personal identifier is accepted. */
export class CloudPopulationStore {
  readonly db: D1Database;
  readonly bucket: R2Bucket;
  constructor(db: D1Database, bucket: R2Bucket) { this.db = db; this.bucket = bucket; }

  /** One area request per ten-minute window across isolates, including provider failures. */
  async acquire(code: string, now: Date): Promise<string | null> {
    areaCode.parse(code);
    const token = crypto.randomUUID(); const stamp = now.toISOString();
    const result = await this.db.prepare(`INSERT INTO population_request_leases(area_code,token,lease_until,next_allowed_at) VALUES(?,?,?,?)
      ON CONFLICT(area_code) DO UPDATE SET token=excluded.token,lease_until=excluded.lease_until,next_allowed_at=excluded.next_allowed_at
      WHERE population_request_leases.lease_until<=? AND population_request_leases.next_allowed_at<=?`)
      .bind(code, token, new Date(now.getTime() + 30000).toISOString(), new Date(now.getTime() + CACHE_MILLISECONDS).toISOString(), stamp, stamp).run();
    return result.meta.changes === 1 ? token : null;
  }

  async release(code: string, token: string, now: Date): Promise<void> {
    await this.db.prepare('UPDATE population_request_leases SET lease_until=? WHERE area_code=? AND token=?').bind(now.toISOString(), code, token).run();
  }

  /** Preserve exact source bytes before parsing, including malformed and rejected responses. */
  async archive(input: PopulationRawRequest): Promise<{ readonly raw_sha256: string; readonly retrieved_at: string }> {
    const parsed = rawRequestSchema.safeParse({ area_code: input.area_code, http_status: input.http_status, retrieved_at: input.retrieved_at });
    if (!parsed.success) throw new PopulationStoreError('invalid_population_record');
    if (input.raw.byteLength > MAX_RAW_BYTES) throw new PopulationStoreError('population_raw_size_exceeded');
    const body = Uint8Array.from(input.raw);
    const digest = await sha256(body);
    const key = `population/raw/${digest}`;
    if (!await this.bucket.head(key)) await this.bucket.put(key, body, {
      httpMetadata: { contentType: 'application/octet-stream' }, customMetadata: { sha256: digest, source: 'seoul_population' },
    });
    await this.db.prepare(`INSERT INTO population_raw_objects(sha256,object_key,size_bytes,first_area_code,http_status,source_url,retrieved_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
      .bind(digest, key, body.byteLength, parsed.data.area_code, parsed.data.http_status, SOURCE_URL, parsed.data.retrieved_at).run();
    return { raw_sha256: digest, retrieved_at: parsed.data.retrieved_at };
  }

  /** Return an expired record with fresh=false so callers can label fallback data explicitly. */
  async read(code: string, now: Date): Promise<PopulationCacheEntry | null> {
    const parsedCode = areaCode.safeParse(code);
    if (!parsedCode.success) throw new PopulationStoreError('invalid_population_record');
    const row = await this.db.prepare(`SELECT o.payload_json,o.raw_sha256,c.retrieved_at,c.expires_at FROM population_cache c JOIN population_observations o ON o.id=c.observation_id WHERE c.area_code=?`).bind(parsedCode.data).first();
    if (!row) return null;
    const cached = cacheRowSchema.parse(row);
    const record = observationSchema.parse(JSON.parse(cached.payload_json));
    if (record.area.code !== code) throw new PopulationStoreError('population_area_mismatch');
    const fresh = now.getTime() >= Date.parse(cached.retrieved_at) && now.getTime() < Date.parse(cached.expires_at);
    return { record, raw_sha256: cached.raw_sha256, retrieved_at: cached.retrieved_at, expires_at: cached.expires_at, fresh };
  }

  /** Archive first, append immutable history, then atomically publish a successful area cache. */
  async write(code: string, value: unknown, raw: Uint8Array, now: Date): Promise<PopulationCacheEntry> {
    const parsed = observationSchema.safeParse(value);
    if (!parsed.success) throw new PopulationStoreError('invalid_population_record');
    const record = parsed.data;
    if (record.area.code !== code) throw new PopulationStoreError('population_area_mismatch');
    const stamp = now.toISOString();
    const expires = new Date(now.getTime() + CACHE_MILLISECONDS).toISOString();
    const archived = await this.archive({ area_code: code, raw, http_status: 200, retrieved_at: record.fetched_at });
    const id = await sha256(new TextEncoder().encode(canonicalJson({ area_code: code, observed_at: record.observed_at, raw_sha256: archived.raw_sha256 })));
    await this.db.batch([
      this.db.prepare(`INSERT INTO population_observations(id,area_code,observed_at,raw_sha256,payload_json,source_url,inserted_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
        .bind(id, code, record.observed_at, archived.raw_sha256, canonicalJson(record), SOURCE_URL, stamp),
      this.db.prepare(`INSERT INTO population_cache(area_code,observation_id,retrieved_at,expires_at) VALUES(?,?,?,?) ON CONFLICT(area_code) DO UPDATE SET observation_id=excluded.observation_id,retrieved_at=excluded.retrieved_at,expires_at=excluded.expires_at WHERE (SELECT observed_at FROM population_observations WHERE id=population_cache.observation_id)<? OR ((SELECT observed_at FROM population_observations WHERE id=population_cache.observation_id)=? AND population_cache.retrieved_at<=excluded.retrieved_at)`)
        .bind(code, id, record.fetched_at, expires, record.observed_at, record.observed_at),
    ]);
    const current = await this.read(code, now);
    if (!current) throw new PopulationStoreError('population_cache_missing');
    return current;
  }
}
