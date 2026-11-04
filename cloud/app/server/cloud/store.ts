import { z } from 'zod';
import { canonicalJson, sha256 } from './contracts.ts';
import type { CollectionJob, JobRequest, Source, StagedPage } from './contracts.ts';
import { clearGuard, CloudStoreError, dayWindow, getInternal, guardedBatch, jobSchema, leaseGuard, publicJob, requireLease } from './storage-rows.ts';
import { publishJob } from './storage-publish.ts';
import { readOverview, readSensors } from './storage-read.ts';
export { CloudStoreError } from './storage-rows.ts';
export type { CloudSensor } from './storage-read.ts';

/** Persistent source history, resumable jobs and atomic publication in D1/R2. */
export class CloudStore {
  readonly db:D1Database;
  readonly bucket:R2Bucket;
  constructor(db:D1Database,bucket:R2Bucket) { this.db=db; this.bucket=bucket; }

  async start(request:JobRequest,now:Date):Promise<CollectionJob> {
    dayWindow(request.day);
    if (request.kind==='collect' && request.source!=='sdot') throw new CloudStoreError('invalid_request');
    if (request.kind==='import' && (request.expected_count===undefined || !Number.isSafeInteger(request.expected_count) || request.expected_count<0)) throw new CloudStoreError('invalid_request');
    const id=crypto.randomUUID();
    const stamp=now.toISOString();
    await this.db.prepare(`INSERT INTO collection_jobs(id,source,day,kind,status,page_no,page_size,total_count,fetched_rows,inserted_rows,error_code,created_at,updated_at,finished_at,lease_token,lease_until) VALUES(?,?,?,?,'pending',1,200,?,0,0,NULL,?,?,NULL,NULL,NULL) ON CONFLICT DO NOTHING`).bind(id,request.source,request.day,request.kind,request.expected_count??null,stamp,stamp).run();
    const row=await this.db.prepare(`SELECT * FROM collection_jobs WHERE source=? AND status IN ('pending','running')`).bind(request.source).first();
    if (!row) throw new CloudStoreError('source_busy');
    const job=jobSchema.parse(row);
    if (job.day!==request.day || job.kind!==request.kind || (request.expected_count!==undefined && job.total_count!==request.expected_count)) throw new CloudStoreError('source_busy');
    return job;
  }

  async get(id:string):Promise<CollectionJob|null> { const job=await getInternal(this.db,id); return job ? publicJob(job) : null; }
  async list():Promise<readonly CollectionJob[]> { return z.array(jobSchema).parse((await this.db.prepare('SELECT * FROM collection_jobs ORDER BY created_at DESC,id DESC LIMIT 30').all()).results); }

  async claim(id:string,token:string,now:Date):Promise<boolean> {
    if (!token) throw new CloudStoreError('invalid_request');
    const result=await this.db.prepare(`UPDATE collection_jobs SET status='running',lease_token=?,lease_until=?,updated_at=? WHERE id=? AND status IN ('pending','running') AND (lease_token IS NULL OR lease_until<=? OR lease_token=?)`).bind(token,new Date(now.getTime()+30000).toISOString(),now.toISOString(),id,now.toISOString(),token).run();
    return result.meta.changes===1;
  }

  async archive(source:Source,body:Uint8Array,now:Date):Promise<string> {
    if (body.byteLength>8*1024*1024) throw new CloudStoreError('raw_size_exceeded');
    const digest=await sha256(body);
    const key=`raw/${digest}`;
    if (!await this.bucket.head(key)) await this.bucket.put(key,Uint8Array.from(body),{httpMetadata:{contentType:'application/octet-stream'},customMetadata:{sha256:digest,source}});
    await this.db.prepare('INSERT INTO raw_objects(sha256,source,object_key,size_bytes,created_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING').bind(digest,source,key,body.byteLength,now.toISOString()).run();
    return digest;
  }

  async stage(id:string,token:string,page:StagedPage,now:Date):Promise<CollectionJob> {
    const initial=await getInternal(this.db,id);
    if (!initial) throw new CloudStoreError('job_missing');
    const fingerprint=await sha256(new TextEncoder().encode(canonicalJson(page.records.map(record=>record.id))));
    if (page.page_no<initial.page_no) {
      const previous=await this.db.prepare('SELECT page_hash FROM job_pages WHERE job_id=? AND page_no=?').bind(id,page.page_no).first<{page_hash:string}>();
      if (previous?.page_hash===fingerprint) return publicJob(initial);
      throw new CloudStoreError('page_mismatch');
    }
    const job=requireLease(initial,token,now);
    if (page.page_no!==job.page_no || page.page_size!==job.page_size || page.page_size>200) throw new CloudStoreError('page_mismatch');
    if (!Number.isSafeInteger(page.total_count) || page.total_count<0 || (job.total_count!==null && page.total_count!==job.total_count)) throw new CloudStoreError('total_changed');
    const expected=Math.min(page.page_size,Math.max(0,page.total_count-(page.page_no-1)*page.page_size));
    if (page.records.length!==expected || job.fetched_rows+page.records.length>page.total_count) throw new CloudStoreError('invalid_page_length');
    if (page.records.length && await this.db.prepare('SELECT 1 FROM job_pages WHERE job_id=? AND page_hash=? LIMIT 1').bind(id,fingerprint).first()) throw new CloudStoreError('repeated_page');
    const window=dayWindow(job.day);
    for (const record of page.records) {
      if (record.source!==job.source) throw new CloudStoreError('record_source_mismatch');
      if (record.observed_at<window.start || record.observed_at>=window.end) throw new CloudStoreError('record_outside_window');
    }
    const rawShas=[...new Set(page.records.map(record=>record.raw_sha))];
    for (let offset=0;offset<rawShas.length;offset+=100) {
      const chunk=rawShas.slice(offset,offset+100);
      const count=await this.db.prepare(`SELECT COUNT(*) AS value FROM raw_objects WHERE sha256 IN (${chunk.map(()=>'?').join(',')})`).bind(...chunk).first<{value:number}>();
      if (count?.value!==chunk.length) throw new CloudStoreError('raw_missing');
    }
    const statements:D1PreparedStatement[]=[leaseGuard(this.db,job,token,now)];
    // Seven records * fourteen columns =98 bindings, below D1's100-parameter cap.
    for (let offset=0;offset<page.records.length;offset+=7) {
      const chunk=page.records.slice(offset,offset+7);
      const values=chunk.flatMap(record=>[record.id,record.source,record.entity_id,record.observed_at,record.published_at,record.revision_rank,record.source_updated_at,record.payload_json,record.lat,record.lon,record.raw_sha,record.ingested_at,record.legacy_id,id]);
      statements.push(this.db.prepare(`INSERT INTO observation_revisions(id,source,entity_id,observed_at,published_at,revision_rank,source_updated_at,payload_json,lat,lon,raw_sha,ingested_at,legacy_id,first_job_id) VALUES ${chunk.map(()=>'(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',')} ON CONFLICT DO NOTHING`).bind(...values));
    }
    for (let offset=0;offset<page.records.length;offset+=50) {
      const chunk=page.records.slice(offset,offset+50);
      statements.push(this.db.prepare(`INSERT INTO job_revisions(job_id,revision_id) VALUES ${chunk.map(()=>'(?,?)').join(',')} ON CONFLICT DO NOTHING`).bind(...chunk.flatMap(record=>[id,record.id])));
    }
    statements.push(this.db.prepare('INSERT INTO job_pages(job_id,page_no,page_hash,record_count) VALUES(?,?,?,?)').bind(id,page.page_no,fingerprint,page.records.length));
    statements.push(this.db.prepare(`UPDATE collection_jobs SET page_no=page_no+1,total_count=?,fetched_rows=fetched_rows+?,inserted_rows=(SELECT COUNT(*) FROM observation_revisions WHERE first_job_id=?),updated_at=? WHERE id=?`).bind(page.total_count,page.records.length,id,now.toISOString(),id),clearGuard(this.db,`lease:${id}`));
    await guardedBatch(this.db,statements);
    const result=await this.get(id);
    if (!result) throw new CloudStoreError('job_missing');
    return result;
  }

  async publish(id:string,token:string,now:Date):Promise<CollectionJob> { return publishJob(this.db,id,token,now); }
  async fail(id:string,token:string,errorCode:string,now:Date):Promise<CollectionJob> {
    const job=requireLease(await getInternal(this.db,id),token,now);
    await guardedBatch(this.db,[leaseGuard(this.db,job,token,now),this.db.prepare(`UPDATE collection_jobs SET status='failed',error_code=?,finished_at=?,updated_at=?,lease_token=NULL,lease_until=NULL WHERE id=?`).bind(errorCode.slice(0,80),now.toISOString(),now.toISOString(),id),clearGuard(this.db,`lease:${id}`)]);
    const result=await this.get(id);
    if (!result) throw new CloudStoreError('job_missing');
    return result;
  }
  async release(id:string,token:string,now:Date):Promise<void> {
    await this.db.prepare(`UPDATE collection_jobs SET lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=? AND status='running'`).bind(now.toISOString(),id,token).run();
  }
  async sensors(sensorId?:string) { return readSensors(this.db,sensorId); }
  async overview() { return readOverview(this.db); }
}
