import { z } from 'zod';
import { canonicalJson, sha256 } from './cloud/contracts.ts';
import { parseContextDataset } from './context-data.ts';
import type { ContextDataset } from './context-data.ts';

export const CONTEXT_SOURCE_IDS = ['songpa-lights', 'seocho-lights', 'songpa-cctv', 'seocho-cctv'] as const;
export const CONTEXT_SCOPE = 'facilities';
export const MAX_CONTEXT_BYTES = 10 * 1024 * 1024;
export const sourceIdSchema = z.enum(CONTEXT_SOURCE_IDS);
export type ContextSourceId = z.infer<typeof sourceIdSchema>;
export const contextJobSchema = z.object({
  id: z.string(), day: z.string(), status: z.enum(['running', 'succeeded', 'failed']),
  next_source_index: z.number().int().min(0).max(4), created_at: z.string(), updated_at: z.string(), finished_at: z.string().nullable(),
  error_code: z.string().nullable(), snapshot_id: z.string().nullable(), unchanged: z.number().int().min(0).max(1),
  lease_token: z.string().nullable(), lease_until: z.string().nullable(),
});
export type ContextJob = Readonly<Omit<z.infer<typeof contextJobSchema>, 'lease_token' | 'lease_until' | 'unchanged'> & { readonly stage_count: number; readonly unchanged: boolean }>;
export type ContextLease = { readonly id: string; readonly token: string; readonly now: Date; readonly index?: number };
export type ContextRawDocument = { readonly source_id: ContextSourceId; readonly role: 'metadata' | 'download_page' | 'download_receipt' | 'csv' | 'mirror_manifest'; readonly url: string; readonly bytes: Uint8Array; readonly sha256: string; readonly content_type: string };
export class ContextStoreError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'ContextStoreError'; this.code = code; }
}
export function publicContextJob(row: z.infer<typeof contextJobSchema>): ContextJob {
  const { lease_token: _token, lease_until: _until, unchanged, ...job } = row;
  return { ...job, stage_count: row.next_source_index, unchanged: unchanged === 1 };
}
export async function getContextJob(db: D1Database, id: string) {
  const row = await db.prepare('SELECT * FROM context_refresh_jobs WHERE id=?').bind(id).first();
  return row ? contextJobSchema.parse(row) : null;
}
export async function requireContextLease(db: D1Database, lease: ContextLease) {
  const job = await getContextJob(db, lease.id);
  if (!job) throw new ContextStoreError('context_job_missing');
  if (job.status !== 'running' || job.lease_token !== lease.token || !job.lease_until || job.lease_until <= lease.now.toISOString()) throw new ContextStoreError('context_lease_lost');
  return job;
}
export async function contextBatch(db: D1Database, lease: ContextLease, statements: readonly D1PreparedStatement[]): Promise<void> {
  const guard = `context:${crypto.randomUUID()}`;
  const cursor = lease.index === undefined ? '' : ' AND next_source_index=?';
  const args: (string | number)[] = [guard, lease.id, lease.token, lease.now.toISOString()];
  if (lease.index !== undefined) args.push(lease.index);
  const check = db.prepare(`INSERT INTO operation_guards(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM context_refresh_jobs WHERE id=? AND status='running' AND lease_token=? AND lease_until>?${cursor}) THEN 1 ELSE 0 END`).bind(...args);
  await db.batch([check, ...statements, db.prepare('DELETE FROM operation_guards WHERE id=?').bind(guard)]);
}
export async function contextSemanticId(dataset: ContextDataset): Promise<string> {
  const sources = dataset.sources.map(source => [source.id, source.raw_sha256]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const facilities = [...dataset.facilities].sort((a, b) => a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);
  return sha256(new TextEncoder().encode(canonicalJson({ format: dataset.format, sources, facilities })));
}
export function completeContextDataset(value: unknown): ContextDataset {
  const dataset = parseContextDataset(value);
  const ids = dataset.sources.map(source => source.id).sort();
  if (canonicalJson(ids) !== canonicalJson([...CONTEXT_SOURCE_IDS].sort())) throw new ContextStoreError('context_source_mismatch');
  return dataset;
}
export async function putContextDataset(bucket: R2Bucket, dataset: ContextDataset) {
  const bytes = new TextEncoder().encode(canonicalJson(dataset));
  if (bytes.byteLength > MAX_CONTEXT_BYTES) throw new ContextStoreError('context_artifact_size_exceeded');
  const artifact_sha256 = await sha256(bytes);
  const object_key = `context/datasets/${artifact_sha256}.json`;
  if (!await bucket.head(object_key)) await bucket.put(object_key, bytes, { httpMetadata: { contentType: 'application/json' }, customMetadata: { sha256: artifact_sha256 } });
  return { object_key, artifact_sha256 };
}
export async function readContextDataset(bucket: R2Bucket, artifact: { readonly object_key: string; readonly artifact_sha256: string }): Promise<ContextDataset> {
  const object = await bucket.get(artifact.object_key);
  if (!object) throw new ContextStoreError('context_snapshot_missing');
  if (object.size > MAX_CONTEXT_BYTES) throw new ContextStoreError('context_artifact_size_exceeded');
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (await sha256(bytes) !== artifact.artifact_sha256) throw new ContextStoreError('context_artifact_digest_mismatch');
  return parseContextDataset(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
}
export const artifactRowSchema = z.object({ object_key: z.string(), artifact_sha256: z.string() });
export const rawDocumentSchema = z.object({
  source_id: sourceIdSchema, role: z.enum(['metadata', 'download_page', 'download_receipt', 'csv', 'mirror_manifest']),
  url: z.url().refine(value => { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && ![...url.searchParams.keys()].some(key => ['key', 'apikey', 'servicekey', 'access_token', 'authorization'].includes(key.toLowerCase())); }),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), content_type: z.string().max(200),
}).strict();
