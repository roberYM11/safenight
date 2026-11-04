# Cloud collection implementation contract

Existing Site identity/audience remain unchanged. Parent owns manifest/env/API auth, cloud map serving, migration client, publication and schedule. All native Sites operations remain with parent.

## Common records

Source: `sdot | sensor_locations`. Provider query: `{source: sdot, day: YYYY-MM-DD, page_no, page_size, full_snapshot:false}`. Times are canonical UTC ISO milliseconds (`Date.toISOString()`). Provider record: `{entity_id, observed_at, published_at, revision_rank, source_updated_at: string|null, payload_json, lat:number|null, lon:number|null}`. Preserve all original provider payload fields plus normalized lux/noise or camera count. Raw bytes are archived before parsing.

Cloud record extends provider record with `{id, source, raw_sha, ingested_at, legacy_id:string|null}`. Compute id from canonical logical contents, so importing a native record and recollecting the same record deduplicate even when the old Python id differs; keep old id as legacy_id. Canonical JSON sorts keys recursively and preserves null vs zero.

## Ownership and module seam

- `contracts.ts` (parent initially; storage worker may extend): Zod boundaries, common types/canonical hashing.
- `providers.ts` (provider worker): `requestPage(query, keys, signal) -> {body:Uint8Array,content_type:string}`; `parsePage(body,query) -> {records,total_count,page_no,page_size}`; typed safe `ProviderError` with `code`.
- `store.ts`, `db/schema.ts`, generated `drizzle/`, storage tests (storage worker): `CloudStore` API below, real D1 tests. Own immutable storage and publication logic.
- `jobs.ts` and coordinator tests (job worker): invokes providers and CloudStore; owns bounded state machine. Does not own HTTP routes or authentication.

`CloudStore` constructor accepts `(db:D1Database,bucket:R2Bucket)`. Required methods (may add typed helpers with coordination):

- `start(request:{source,day,kind:'collect'|'import',expected_count?:number}, now:Date):Promise<CollectionJob>`; reuse unfinished matching job, never overwrite a source job in progress.
- `get(jobId):Promise<CollectionJob|null>` and `list():Promise<readonly CollectionJob[]>`.
- `claim(jobId, token, now):Promise<boolean>`: resumable lease with expiry, rejects concurrent holder.
- `archive(source,body,now):Promise<string>`: SHA256-addressed R2 object + D1 metadata, raw-before-parse.
- `stage(jobId,token,{records:readonly CloudRecord[],total_count,page_no,page_size},now):Promise<CollectionJob>`: atomic stage + cursor, duplicate page safe; requires current lease. Maximum page_size200.
- `publish(jobId,token,now):Promise<CollectionJob>`: verifies all rows/pages then atomically selects revision winners, updates contiguous source checkpoint, completes job and releases source lock. No partial/current visibility; same-priority different payload is a conflict, not an arbitrary winner.
- `fail(jobId,token,errorCode,now):Promise<CollectionJob>` and `release(jobId,token,now):Promise<void>`.
- `sensors():Promise<{sensors: readonly CloudSensor[],total_sensors,unlocated_sensors}>` returns latest published S-DoT + latest effective published location at/before observation. `CloudSensor` matches existing Feature + district/neighborhood and valid coords; `feature_revision` records both input revision IDs.
- `overview():Promise<...>` bounded counts/checkpoints/run status for operator readback, no secrets.

`CollectionJob`: `{id,source,day,kind,status:'pending'|'running'|'succeeded'|'failed',page_no,page_size,total_count:number|null,fetched_rows,inserted_rows,error_code:string|null,created_at,updated_at,finished_at:string|null}`. page_no is next page. Job worker may request retry_failed explicit flag if needed; preserve failed history.

Coordinator: `step(store,jobId,keys,now):Promise<CollectionJob>` processes exactly ONE provider page per HTTP request (S-DoT page200). Uses eight-second provider timeout, raw-before-parse, checked totals/length/repeated identity, stage, publish only final page. No training, no collection from GET/map. Import jobs use separate explicit operator route with raw uploads and record batches, never public fixture data.

Scheduling: `/api/internal/collection` authenticated POST supports `{action:'due'}` (plan missing completed KST days + recent correction window), `{action:'step',job_id}` and `{action:'start',source,day}`; GET gives bounded overview. Cloud task drives jobs until complete, while model requests remain separate. Retention limits/catchup must be explicit; no skipping gaps. Source keys exist only in Sites secrets. Parent may adjust route names while retaining shared module methods.

Schema migrations are DDL-only. Initial source records arrive through authenticated import operations, never migrations. Original native DB backup also preserved in R2. No raw download or arbitrary URL fetch endpoint is exposed to browsers.
