import { z } from 'zod';
import { canonicalJson, sha256 } from './cloud/contracts.ts';
import { parseContextDataset } from './context-data.ts';
import type { ContextDataset } from './context-data.ts';
import { artifactRowSchema, completeContextDataset, contextBatch, contextJobSchema, contextSemanticId, CONTEXT_SCOPE, CONTEXT_SOURCE_IDS, ContextStoreError, getContextJob, MAX_CONTEXT_BYTES, publicContextJob, putContextDataset, rawDocumentSchema, readContextDataset, requireContextLease, sourceIdSchema } from './context-store-records.ts';
import type { ContextJob, ContextRawDocument, ContextSourceId } from './context-store-records.ts';
export { ContextStoreError, CONTEXT_SOURCE_IDS } from './context-store-records.ts';
export type { ContextJob, ContextRawDocument, ContextSourceId } from './context-store-records.ts';

/** Daily source checks append immutable artifacts; only a complete four-source job changes current data. */
export class CloudContextStore {
  readonly db: D1Database; readonly bucket: R2Bucket;
  constructor(db: D1Database, bucket: R2Bucket) { this.db = db; this.bucket = bucket; }

  async ensureSeed(value: ContextDataset, now: Date): Promise<void> {
    if (await this.db.prepare('SELECT 1 FROM context_current WHERE scope=?').bind(CONTEXT_SCOPE).first()) return;
    const dataset = completeContextDataset(value); const id = await contextSemanticId(dataset);
    const artifact = await putContextDataset(this.bucket, dataset);
    await this.db.batch([
      this.db.prepare('INSERT INTO context_snapshots(id,object_key,artifact_sha256,sources_json,source_count,facility_count,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').bind(id, artifact.object_key, artifact.artifact_sha256, canonicalJson(dataset.sources), dataset.sources.length, dataset.facilities.length, now.toISOString()),
      this.db.prepare('INSERT INTO context_current(scope,snapshot_id,checked_at) VALUES(?,?,?) ON CONFLICT DO NOTHING').bind(CONTEXT_SCOPE, id, now.toISOString()),
    ]);
  }

  async current(): Promise<{ readonly id: string; readonly dataset: ContextDataset; readonly checked_at: string } | null> {
    const row = await this.db.prepare('SELECT s.id,s.object_key,s.artifact_sha256,c.checked_at FROM context_current c JOIN context_snapshots s ON s.id=c.snapshot_id WHERE c.scope=?').bind(CONTEXT_SCOPE).first();
    if (!row) return null;
    const selected = artifactRowSchema.extend({ id: z.string(), checked_at: z.string() }).parse(row);
    return { id: selected.id, dataset: completeContextDataset(await readContextDataset(this.bucket, selected)), checked_at: selected.checked_at };
  }

  async overview() {
    const current = await this.db.prepare('SELECT s.id,s.created_at,s.source_count,s.facility_count,c.checked_at FROM context_current c JOIN context_snapshots s ON s.id=c.snapshot_id WHERE c.scope=?').bind(CONTEXT_SCOPE).first();
    const currentSchema = z.object({ id: z.string(), created_at: z.string(), checked_at: z.string(), source_count: z.number(), facility_count: z.number() });
    const jobs = z.array(contextJobSchema).parse((await this.db.prepare('SELECT * FROM context_refresh_jobs ORDER BY created_at DESC,id DESC LIMIT 20').all()).results);
    return { current: current ? currentSchema.parse(current) : null, jobs: jobs.map(publicContextJob) };
  }

  async get(id: string): Promise<ContextJob | null> { const job = await getContextJob(this.db, id); return job ? publicContextJob(job) : null; }

  async start(now: Date): Promise<ContextJob> {
    const stamp = now.toISOString(); const day = new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10); const id = crypto.randomUUID();
    await this.db.prepare(`INSERT INTO context_refresh_jobs(id,scope,day,status,next_source_index,created_at,updated_at,finished_at,error_code,snapshot_id,unchanged,lease_token,lease_until) SELECT ?,?,?,'running',0,?,?,NULL,NULL,NULL,0,NULL,NULL WHERE NOT EXISTS(SELECT 1 FROM context_refresh_jobs WHERE scope=? AND day=? AND status='succeeded') ON CONFLICT DO NOTHING`).bind(id, CONTEXT_SCOPE, day, stamp, stamp, CONTEXT_SCOPE, day).run();
    const row = await this.db.prepare(`SELECT * FROM context_refresh_jobs WHERE scope=? AND (status='running' OR (day=? AND status='succeeded')) ORDER BY CASE WHEN status='running' THEN 0 ELSE 1 END,created_at DESC LIMIT 1`).bind(CONTEXT_SCOPE, day).first();
    if (!row) throw new ContextStoreError('context_job_busy');
    return publicContextJob(contextJobSchema.parse(row));
  }

  async claim(id: string, now: Date): Promise<string | null> {
    const token = crypto.randomUUID(); const stamp = now.toISOString();
    const result = await this.db.prepare(`UPDATE context_refresh_jobs SET lease_token=?,lease_until=?,updated_at=? WHERE id=? AND status='running' AND (lease_token IS NULL OR lease_until<=?)`).bind(token, new Date(now.getTime() + 120000).toISOString(), stamp, id, stamp).run();
    return result.meta.changes === 1 ? token : null;
  }

  async release(id: string, token: string, now: Date): Promise<void> {
    await this.db.prepare(`UPDATE context_refresh_jobs SET lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=? AND status='running'`).bind(now.toISOString(), id, token).run();
  }

  async archive(id: string, document: ContextRawDocument, now: Date, token: string): Promise<void> {
    const lease = { id, token, now }; await requireContextLease(this.db, lease);
    const { bytes, ...metadata } = document; const raw = rawDocumentSchema.parse(metadata);
    if (bytes.byteLength > MAX_CONTEXT_BYTES) throw new ContextStoreError('context_raw_size_exceeded');
    const body = Uint8Array.from(bytes); const digest = await sha256(body);
    if (digest !== raw.sha256) throw new ContextStoreError('context_raw_digest_mismatch');
    const objectKey = `context/raw/${digest}`;
    if (!await this.bucket.head(objectKey)) await this.bucket.put(objectKey, body, { httpMetadata: { contentType: raw.content_type || 'application/octet-stream' }, customMetadata: { sha256: digest } });
    const identity = await sha256(new TextEncoder().encode(canonicalJson({ job_id: id, ...raw })));
    await contextBatch(this.db, lease, [this.db.prepare('INSERT INTO context_raw_documents(id,job_id,source_id,role,url,sha256,object_key,size_bytes,content_type,retrieved_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').bind(identity, id, raw.source_id, raw.role, raw.url, digest, objectKey, body.byteLength, raw.content_type, now.toISOString())]);
  }

  async stage(id: string, sourceId: ContextSourceId, value: ContextDataset, now: Date, token: string): Promise<ContextJob> {
    const lease = { id, token, now }; const job = await requireContextLease(this.db, lease);
    const dataset = parseContextDataset(value); const source = sourceIdSchema.parse(sourceId);
    if (dataset.sources.length !== 1 || dataset.sources[0].id !== source) throw new ContextStoreError('context_source_mismatch');
    const sourceIndex = CONTEXT_SOURCE_IDS.indexOf(source); const semanticId = await contextSemanticId(dataset);
    const previous = await this.db.prepare('SELECT semantic_id FROM context_staged_sources WHERE job_id=? AND source_id=?').bind(id, source).first<{ semantic_id: string }>();
    if (previous) { if (previous.semantic_id !== semanticId) throw new ContextStoreError('context_stage_conflict'); return publicContextJob(job); }
    if (sourceIndex !== job.next_source_index) throw new ContextStoreError('context_source_order');
    if (!await this.db.prepare(`SELECT 1 FROM context_raw_documents WHERE job_id=? AND source_id=? AND role='csv' AND sha256=?`).bind(id, source, dataset.sources[0].raw_sha256).first()) throw new ContextStoreError('context_raw_missing');
    const artifact = await putContextDataset(this.bucket, dataset);
    await contextBatch(this.db, { ...lease, index: sourceIndex }, [
      this.db.prepare('INSERT INTO context_staged_sources(job_id,source_id,source_index,object_key,artifact_sha256,semantic_id,stored_at) VALUES(?,?,?,?,?,?,?)').bind(id, source, sourceIndex, artifact.object_key, artifact.artifact_sha256, semanticId, now.toISOString()),
      this.db.prepare('UPDATE context_refresh_jobs SET next_source_index=next_source_index+1,updated_at=? WHERE id=?').bind(now.toISOString(), id),
    ]);
    const result = await this.get(id); if (!result) throw new ContextStoreError('context_job_missing'); return result;
  }

  async publish(id: string, now: Date, token: string): Promise<ContextJob> {
    const existing = await this.get(id); if (!existing) throw new ContextStoreError('context_job_missing');
    if (existing.status === 'succeeded') return existing;
    const lease = { id, token, now, index: 4 }; const job = await requireContextLease(this.db, lease);
    if (job.next_source_index !== 4) throw new ContextStoreError('context_incomplete');
    const rows = z.array(artifactRowSchema.extend({ source_id: sourceIdSchema, source_index: z.number().int() })).parse((await this.db.prepare('SELECT * FROM context_staged_sources WHERE job_id=? ORDER BY source_index').bind(id).all()).results);
    if (rows.length !== 4 || rows.some((row, index) => row.source_id !== CONTEXT_SOURCE_IDS[index] || row.source_index !== index)) throw new ContextStoreError('context_incomplete');
    const parts = await Promise.all(rows.map(row => readContextDataset(this.bucket, row)));
    const dataset = completeContextDataset({ format: 'safenight-context-v1', sources: parts.flatMap(part => part.sources), facilities: parts.flatMap(part => part.facilities) });
    const snapshotId = await contextSemanticId(dataset);
    const current = await this.db.prepare('SELECT snapshot_id FROM context_current WHERE scope=?').bind(CONTEXT_SCOPE).first<{ snapshot_id: string }>();
    const unchanged = current?.snapshot_id === snapshotId;
    const statements: D1PreparedStatement[] = [];
    if (!await this.db.prepare('SELECT 1 FROM context_snapshots WHERE id=?').bind(snapshotId).first()) {
      const artifact = await putContextDataset(this.bucket, dataset);
      statements.push(this.db.prepare('INSERT INTO context_snapshots(id,object_key,artifact_sha256,sources_json,source_count,facility_count,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').bind(snapshotId, artifact.object_key, artifact.artifact_sha256, canonicalJson(dataset.sources), dataset.sources.length, dataset.facilities.length, now.toISOString()));
    }
    statements.push(this.db.prepare('INSERT INTO context_current(scope,snapshot_id,checked_at) VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET snapshot_id=excluded.snapshot_id,checked_at=excluded.checked_at').bind(CONTEXT_SCOPE, snapshotId, now.toISOString()));
    statements.push(this.db.prepare(`UPDATE context_refresh_jobs SET status='succeeded',updated_at=?,finished_at=?,snapshot_id=?,unchanged=?,lease_token=NULL,lease_until=NULL WHERE id=?`).bind(now.toISOString(), now.toISOString(), snapshotId, unchanged ? 1 : 0, id));
    await contextBatch(this.db, lease, statements);
    const result = await this.get(id); if (!result) throw new ContextStoreError('context_job_missing'); return result;
  }

  async fail(id: string, errorCode: string, now: Date, token: string): Promise<ContextJob> {
    const job = await this.get(id); if (!job) throw new ContextStoreError('context_job_missing');
    if (job.status !== 'running') return job;
    const lease = { id, token, now }; await requireContextLease(this.db, lease);
    const code = /^[a-z0-9_:-]{1,80}$/.test(errorCode) ? errorCode : 'context_source_failed';
    await contextBatch(this.db, lease, [this.db.prepare(`UPDATE context_refresh_jobs SET status='failed',error_code=?,updated_at=?,finished_at=?,lease_token=NULL,lease_until=NULL WHERE id=?`).bind(code, now.toISOString(), now.toISOString(), id)]);
    const result = await this.get(id); if (!result) throw new ContextStoreError('context_job_missing'); return result;
  }
}
