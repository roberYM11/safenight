import { z } from 'zod';
import { sourceSchema } from './contracts.ts';
import type { CollectionJob } from './contracts.ts';

export const jobSchema = z.object({
  id:z.string(), source:sourceSchema, day:z.string(), kind:z.enum(['collect','import']), status:z.enum(['pending','running','succeeded','failed']),
  page_no:z.number().int(), page_size:z.number().int(), total_count:z.number().int().nullable(),
  fetched_rows:z.number().int(), inserted_rows:z.number().int(), error_code:z.string().nullable(),
  created_at:z.string(), updated_at:z.string(), finished_at:z.string().nullable(),
});
export const internalJobSchema = jobSchema.extend({lease_token:z.string().nullable(),lease_until:z.string().nullable()});
export type InternalJob = z.infer<typeof internalJobSchema>;
export type StorageCode = 'job_missing'|'source_busy'|'job_not_running'|'lease_lost'|'page_mismatch'|'total_changed'|'invalid_page_length'|'repeated_page'|'record_source_mismatch'|'record_outside_window'|'raw_missing'|'revision_conflict'|'coverage_gap'|'invalid_request'|'raw_size_exceeded';
export class CloudStoreError extends Error {
  readonly code:StorageCode;
  constructor(code:StorageCode) { super(code); this.name='CloudStoreError'; this.code=code; }
}
export function dayWindow(day:string):{readonly start:string;readonly end:string} {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new CloudStoreError('invalid_request');
  const start=new Date(`${day}T00:00:00+09:00`);
  if (!Number.isFinite(start.getTime()) || new Date(start.getTime()+9*3600000).toISOString().slice(0,10)!==day) throw new CloudStoreError('invalid_request');
  return {start:start.toISOString(),end:new Date(start.getTime()+86400000).toISOString()};
}
export async function getInternal(db:D1Database,id:string):Promise<InternalJob|null> {
  const row=await db.prepare('SELECT * FROM collection_jobs WHERE id=?').bind(id).first();
  return row ? internalJobSchema.parse(row) : null;
}
export function publicJob(job:InternalJob):CollectionJob { return jobSchema.parse(job); }
export function requireLease(job:InternalJob|null,token:string,now:Date):InternalJob {
  if (!job) throw new CloudStoreError('job_missing');
  if (job.status!=='running') throw new CloudStoreError('job_not_running');
  if (job.lease_token!==token || job.lease_until===null || job.lease_until<=now.toISOString()) throw new CloudStoreError('lease_lost');
  return job;
}
export function leaseGuard(db:D1Database,job:CollectionJob,token:string,now:Date):D1PreparedStatement {
  return db.prepare(`INSERT INTO operation_guards(id,ok) VALUES(?,(SELECT COUNT(*) FROM collection_jobs WHERE id=? AND status='running' AND lease_token=? AND lease_until>? AND page_no=?))`).bind(`lease:${job.id}`,job.id,token,now.toISOString(),job.page_no);
}
export function clearGuard(db:D1Database,id:string):D1PreparedStatement { return db.prepare('DELETE FROM operation_guards WHERE id=?').bind(id); }
export async function guardedBatch(db:D1Database,statements:D1PreparedStatement[]):Promise<void> {
  try { await db.batch(statements); }
  catch (error) {
    if (error instanceof Error && error.message.includes('operation_guard_ok')) throw new CloudStoreError('lease_lost');
    throw error;
  }
}
