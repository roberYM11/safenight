import { z } from 'zod';

export const sourceSchema = z.enum(['sdot', 'sensor_locations']);
export type Source = z.infer<typeof sourceSchema>;
const timestamp = z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString());
export const providerRecordSchema = z.object({
  entity_id: z.string().min(1), observed_at: timestamp, published_at: timestamp,
  revision_rank: z.number().int().nonnegative(), source_updated_at: timestamp.nullable(),
  payload_json: z.string().min(2), lat: z.number().finite().min(-90).max(90).nullable(),
  lon: z.number().finite().min(-180).max(180).nullable(),
}).readonly();
export type ProviderRecord = z.infer<typeof providerRecordSchema>;
export const cloudRecordSchema = providerRecordSchema.unwrap().extend({
  id: z.string().regex(/^[a-f0-9]{64}$/), source: sourceSchema,
  raw_sha: z.string().regex(/^[a-f0-9]{64}$/), ingested_at: timestamp,
  legacy_id: z.string().nullable().default(null),
}).readonly();
export type CloudRecord = z.infer<typeof cloudRecordSchema>;
export type ProviderQuery = { readonly source:'sdot'; readonly day:string; readonly page_no:number; readonly page_size:number; readonly full_snapshot:false };
export type SourceKeys = { readonly sdot:string };
export type ParsedPage = { readonly records:readonly ProviderRecord[]; readonly total_count:number; readonly page_no:number; readonly page_size:number };
export type JobRequest = { readonly source:Source; readonly day:string; readonly kind:'collect'|'import'; readonly expected_count?:number };
export type CollectionJob = { readonly id:string; readonly source:Source; readonly day:string; readonly kind:'collect'|'import'; readonly status:'pending'|'running'|'succeeded'|'failed'; readonly page_no:number; readonly page_size:number; readonly total_count:number|null; readonly fetched_rows:number; readonly inserted_rows:number; readonly error_code:string|null; readonly created_at:string; readonly updated_at:string; readonly finished_at:string|null };
export type StagedPage = { readonly records:readonly CloudRecord[]; readonly total_count:number; readonly page_no:number; readonly page_size:number };

type Json = null|boolean|number|string|readonly Json[]|{readonly [key:string]:Json};
function sorted(value:Json):Json {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,sorted(item)]));
  return value;
}
export function canonicalJson(value:unknown):string { return JSON.stringify(sorted(z.json().parse(value))); }
export async function sha256(bytes:Uint8Array):Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)));
  return Array.from(digest, value=>value.toString(16).padStart(2,'0')).join('');
}
export async function cloudRecord(source:Source, record:ProviderRecord, raw_sha:string, now:Date, legacy_id:string|null=null):Promise<CloudRecord> {
  const parsed = providerRecordSchema.parse(record);
  const normalized = {...parsed,payload_json:canonicalJson(JSON.parse(parsed.payload_json))};
  const id = await sha256(new TextEncoder().encode(canonicalJson({source,...normalized})));
  return {...normalized,id,source,raw_sha,ingested_at:now.toISOString(),legacy_id};
}
