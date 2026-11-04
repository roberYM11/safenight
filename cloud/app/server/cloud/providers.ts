import ky, { HTTPError, NetworkError, ResponseSizeError, TimeoutError } from 'ky';
import { z } from 'zod';
import { canonicalJson } from './contracts.ts';
import type { ParsedPage, ProviderQuery, ProviderRecord, SourceKeys } from './contracts.ts';

const DAY_MS = 86_400_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const querySchema = z.object({
  source: z.literal('sdot'), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  page_no: z.number().int().min(1).max(10000), page_size: z.number().int().min(1).max(200),
  full_snapshot: z.literal(false),
}).readonly();
const resultSchema = z.object({ CODE: z.string() });
const rowSchema = z.object({
  SERIAL: z.string().min(1), SENSING_TIME: z.string(), DATE: z.string(),
  DATA_NO: z.enum(['1', '2']), AVG_INTE_ILLU: z.string().nullable(), AVG_NOISE: z.string().nullable(),
}).passthrough();
const envelopeSchema = z.object({
  sDoTEnv: z.object({
    list_total_count: z.number().int().nonnegative(), RESULT: resultSchema,
    row: z.array(rowSchema).default([]),
  }).nullable().optional(),
  RESULT: resultSchema.nullable().optional(),
});

export type ProviderCode = 'invalid_query'|'invalid_provider_time'|'invalid_number'|'sdot_key_missing'|
  'sdot_http_error'|'sdot_transport_error'|'sdot_timeout'|'sdot_body_too_large'|'sdot_invalid_payload'|
  'sdot_provider_rejected'|'sdot_invalid_pagination'|'sdot_row_outside_window'|'sdot_excessive_clock_skew';

/** Public diagnostics contain codes, never credential-bearing URLs or provider bodies. */
export class ProviderError extends Error {
  readonly code: ProviderCode;
  constructor(code: ProviderCode) { super(code); this.name = 'ProviderError'; this.code = code; }
}

export type ProviderResponse = { readonly body: Uint8Array; readonly content_type: string };

/** Interpret a calendar day as midnight in Korea and reject normalized invalid dates. */
export function dayStart(day: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new ProviderError('invalid_query');
  const time = Date.parse(`${day}T00:00:00.000+09:00`);
  if (!Number.isFinite(time) || new Date(time + 9 * 3_600_000).toISOString().slice(0, 10) !== day) throw new ProviderError('invalid_query');
  return time;
}

function checkedQuery(query: ProviderQuery): ProviderQuery {
  const parsed = querySchema.safeParse(query);
  if (!parsed.success) throw new ProviderError('invalid_query');
  dayStart(parsed.data.day);
  return parsed.data;
}

/** Parse the verified S-DoT clocks without applying the host machine's timezone. */
export function providerTime(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})(?:[T _](\d{2})[:-](\d{2})(?:[:-](\d{2})(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(value);
  if (!match) throw new ProviderError('invalid_provider_time');
  const [, day, hour = '00', minute = '00', second = '00', fraction = '', zone = '+09:00'] = match;
  try { dayStart(day); } catch (error) {
    if (error instanceof ProviderError) throw new ProviderError('invalid_provider_time');
    throw error;
  }
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) throw new ProviderError('invalid_provider_time');
  const milliseconds = Date.parse(`${day}T${hour}:${minute}:${second}${fraction}${zone}`);
  if (!Number.isFinite(milliseconds)) throw new ProviderError('invalid_provider_time');
  return new Date(milliseconds).toISOString();
}

function optionalNumber(value: string|null, maximum: number): number|null {
  if (value === null || !value.trim()) return null;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) throw new ProviderError('invalid_number');
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > maximum) throw new ProviderError('invalid_number');
  return number;
}

/** Read bounded bytes only; the coordinator archives them before calling parsePage. */
export async function requestPage(query: ProviderQuery, keys: SourceKeys, signal: AbortSignal, fetcher?: typeof globalThis.fetch): Promise<ProviderResponse> {
  const parsed = checkedQuery(query);
  if (!keys.sdot.trim()) throw new ProviderError('sdot_key_missing');
  const start = (parsed.page_no - 1) * parsed.page_size + 1;
  const end = start + parsed.page_size - 1;
  const url = `http://openapi.seoul.go.kr:8088/${encodeURIComponent(keys.sdot)}/json/sDoTEnv/${start}/${end}/${parsed.day}`;
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
  if (requestSignal.aborted) throw new ProviderError('sdot_timeout');
  try {
    const response = await ky.get(url, { retry: 0, timeout: false, redirect: 'manual', maxResponseSize: MAX_BODY_BYTES, signal: requestSignal, ...(fetcher ? { fetch: fetcher } : {}) });
    if (response.status !== 200) throw new ProviderError('sdot_http_error');
    if (Number(response.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) throw new ProviderError('sdot_body_too_large');
    const body = new Uint8Array(await response.arrayBuffer());
    return { body, content_type: response.headers.get('content-type') ?? 'application/json' };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (error instanceof ResponseSizeError) throw new ProviderError('sdot_body_too_large');
    if (requestSignal.aborted || error instanceof TimeoutError) throw new ProviderError('sdot_timeout');
    if (error instanceof HTTPError) throw new ProviderError('sdot_http_error');
    if (error instanceof NetworkError || error instanceof DOMException) throw new ProviderError('sdot_transport_error');
    throw error;
  }
}

/** Preserve source extras, units, correction rank, and null-versus-zero meaning. */
export function parsePage(body: Uint8Array, query: ProviderQuery): ParsedPage {
  const parsed = checkedQuery(query);
  let envelope: z.infer<typeof envelopeSchema>;
  try { envelope = envelopeSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))); }
  catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError || error instanceof TypeError) throw new ProviderError('sdot_invalid_payload');
    throw error;
  }
  const data = envelope.sDoTEnv;
  if (!data) {
    if (envelope.RESULT?.CODE === 'INFO-200') return { records: [], total_count: 0, page_no: parsed.page_no, page_size: parsed.page_size };
    throw new ProviderError('sdot_provider_rejected');
  }
  if (data.RESULT.CODE !== 'INFO-000' && data.RESULT.CODE !== 'INFO-200') throw new ProviderError('sdot_provider_rejected');
  const expected = Math.min(parsed.page_size, Math.max(0, data.list_total_count - (parsed.page_no - 1) * parsed.page_size));
  if (data.row.length !== expected) throw new ProviderError('sdot_invalid_pagination');
  const start = dayStart(parsed.day);
  const records: readonly ProviderRecord[] = data.row.map(row => {
    const observed = providerTime(row.SENSING_TIME);
    const published = providerTime(row.DATE);
    if (Date.parse(observed) < start || Date.parse(observed) >= start + DAY_MS) throw new ProviderError('sdot_row_outside_window');
    const skew = Math.max(0, (Date.parse(observed) - Date.parse(published)) / 1000);
    if (skew > 300) throw new ProviderError('sdot_excessive_clock_skew');
    const payload = { ...row, lux: optionalNumber(row.AVG_INTE_ILLU, 200000), noise_db: optionalNumber(row.AVG_NOISE, 150), source_clock_skew_seconds: skew };
    return { entity_id: row.SERIAL, observed_at: observed, published_at: published, revision_rank: Number(row.DATA_NO), source_updated_at: published, payload_json: canonicalJson(payload), lat: null, lon: null };
  });
  return { records, total_count: data.list_total_count, page_no: parsed.page_no, page_size: parsed.page_size };
}
