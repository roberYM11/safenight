import { cloudRecord } from './contracts.ts';
import type { CloudRecord, CollectionJob, ProviderQuery, SourceKeys, StagedPage } from './contracts.ts';
import { dayStart, parsePage, ProviderError, requestPage } from './providers.ts';
import type { ProviderResponse } from './providers.ts';
import { CloudStoreError } from './store.ts';

const DAY_MS = 86_400_000;
export type JobCode = 'job_missing'|'wrong_job_kind'|'unsupported_source'|'source_total_exceeded'|'invalid_checkpoint'|'invalid_schedule';
export class JobError extends Error {
  readonly code: JobCode;
  constructor(code: JobCode) { super(code); this.name = 'JobError'; this.code = code; }
}

/** Narrow storage contract also supports isolated coordinator tests without framework bindings. */
export interface JobStore {
  get(jobId:string):Promise<CollectionJob|null>;
  claim(jobId:string,token:string,now:Date):Promise<boolean>;
  archive(source:'sdot',body:Uint8Array,now:Date):Promise<string>;
  stage(jobId:string,token:string,page:StagedPage,now:Date):Promise<CollectionJob>;
  publish(jobId:string,token:string,now:Date):Promise<CollectionJob>;
  fail(jobId:string,token:string,errorCode:string,now:Date):Promise<CollectionJob>;
  release(jobId:string,token:string,now:Date):Promise<void>;
}
type PageRequester = (query:ProviderQuery,keys:SourceKeys,signal:AbortSignal)=>Promise<ProviderResponse>;

/** Process one resumable page; a GET/map request never calls this operation. */
export async function step(store:JobStore,jobId:string,keys:SourceKeys,now=new Date(),request:PageRequester=requestPage,clock:()=>Date=()=>now):Promise<CollectionJob> {
  const job = await store.get(jobId);
  if (!job) throw new JobError('job_missing');
  switch (job.status) {
    case 'succeeded': case 'failed': return job;
    case 'pending': case 'running': break;
    default: return unreachable(job.status);
  }
  if (job.kind !== 'collect') throw new JobError('wrong_job_kind');
  if (job.source !== 'sdot') throw new JobError('unsupported_source');
  const token = crypto.randomUUID();
  if (!await store.claim(jobId,token,now)) return await store.get(jobId) ?? job;
  try {
    // A prior caller may have advanced the durable cursor between get() and claim().
    const claimed = await store.get(jobId);
    if (!claimed) throw new JobError('job_missing');
    if (claimed.total_count !== null && claimed.fetched_rows === claimed.total_count) return await store.publish(jobId,token,clock());
    const query:ProviderQuery = { source:'sdot',day:claimed.day,page_no:claimed.page_no,page_size:claimed.page_size,full_snapshot:false };
    const response = await request(query,keys,AbortSignal.timeout(8000));
    const rawSha = await store.archive('sdot',response.body,now);
    const page = parsePage(response.body,query);
    if (page.total_count > 500000) throw new JobError('source_total_exceeded');
    if (claimed.total_count !== null && claimed.total_count !== page.total_count) return await store.fail(jobId,token,'total_changed',now);
    const records:readonly CloudRecord[] = await Promise.all(page.records.map(row=>cloudRecord('sdot',row,rawSha,now)));
    const staged = await store.stage(jobId,token,{ ...page,records },now);
    if (staged.fetched_rows === page.total_count) return await store.publish(jobId,token,clock());
    return staged;
  } catch (error) {
    if (error instanceof ProviderError || error instanceof JobError) return await store.fail(jobId,token,error.code,now);
    if (error instanceof CloudStoreError) {
      if (error.code === 'lease_lost') return await store.get(jobId) ?? job;
      return await store.fail(jobId,token,error.code,now);
    }
    throw error;
  } finally { await store.release(jobId,token,now); }
}

export type DuePlan = {
  readonly status:'ready'|'retry_deferred'|'archive_backfill_required';
  readonly target_end:string; readonly days:readonly string[]; readonly pending_job_ids:readonly string[];
  readonly retry_at:string|null;
};
export type DueInput = { readonly now:Date; readonly covered_until:string|null; readonly jobs:readonly CollectionJob[]; readonly correction_days?:number; readonly collection_hour?:number };
function dayKey(time:number):string { return new Date(time + 9 * 3_600_000).toISOString().slice(0,10); }

/** Plan complete Korean days, preserve gaps, and recheck corrections once each schedule day. */
export function planDue(input:DueInput):DuePlan {
  const { now,covered_until,jobs,correction_days=7,collection_hour=3 } = input;
  if (!Number.isFinite(now.getTime()) || !Number.isInteger(correction_days) || correction_days < 1 || correction_days > 29 || !Number.isInteger(collection_hour) || collection_hour < 0 || collection_hour > 23) throw new JobError('invalid_schedule');
  const local = new Date(now.getTime() + 9 * 3_600_000);
  const today = dayStart(local.toISOString().slice(0,10));
  const target = today - (local.getUTCHours() < collection_hour ? DAY_MS : 0);
  const targetEnd = new Date(target).toISOString();
  const collected = jobs.filter(job=>job.source === 'sdot' && job.kind === 'collect');
  const active = collected.filter(job=>job.status === 'pending' || job.status === 'running').sort((a,b)=>a.day.localeCompare(b.day)||a.created_at.localeCompare(b.created_at));
  if (active.length) return { status:'ready',target_end:targetEnd,days:[],pending_job_ids:active.map(job=>job.id),retry_at:null };
  const latest = [...collected].sort((a,b)=>b.created_at.localeCompare(a.created_at))[0];
  const retryAt = latest?.status === 'failed' ? Date.parse(latest.finished_at ?? latest.updated_at) + 15 * 60_000 : 0;
  if (retryAt > now.getTime()) return { status:'retry_deferred',target_end:targetEnd,days:[],pending_job_ids:[],retry_at:new Date(retryAt).toISOString() };
  let start = target - DAY_MS;
  if (covered_until !== null) {
    start = Date.parse(covered_until);
    if (!Number.isFinite(start) || dayStart(dayKey(start)) !== start) throw new JobError('invalid_checkpoint');
  }
  if (target - start > 29 * DAY_MS) return { status:'archive_backfill_required',target_end:targetEnd,days:[],pending_job_ids:[],retry_at:null };
  const days:string[] = []; // Ordered accumulator: missing dates precede correction rechecks.
  for (let time=start;time<target;time+=DAY_MS) days.push(dayKey(time));
  const checkedToday = new Set(collected.filter(job=>job.status === 'succeeded' && Date.parse(job.created_at) >= today).map(job=>job.day));
  for (let offset=correction_days;offset>0;offset--) {
    const day=dayKey(target-offset*DAY_MS);
    if (!checkedToday.has(day) && !days.includes(day)) days.push(day);
  }
  return { status:'ready',target_end:targetEnd,days,pending_job_ids:[],retry_at:null };
}

function unreachable(value:never):never { throw new TypeError(`Unexpected job status: ${String(value)}`); }
