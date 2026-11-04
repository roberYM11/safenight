import ky, { ResponseSizeError, TimeoutError } from 'ky';
import { z } from 'zod';
import { sha256 } from './cloud/contracts.ts';
import { contextDefinitions, CONTEXT_SOURCE_IDS, contextSourceIdSchema, parseContextCsv, parseContextMetadata } from './context-source-parser.ts';
import type { ContextSourceId } from './context-source-parser.ts';
import type { CloudContextStore } from './context-store.ts';

export const CONTEXT_MIRROR_BASE = 'https://raw.githubusercontent.com/roberYM11/safenight/safenight-facility-data/';
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_RAW_BYTES = 10 * 1024 * 1024;
const roles = z.enum(['metadata', 'download_receipt', 'download_page', 'csv']);
const documentSchema = z.object({
  role: roles, official_url: z.url(), sha256: z.string().regex(/^[a-f0-9]{64}$/), size_bytes: z.number().int().min(1).max(MAX_RAW_BYTES),
  content_type: z.string().max(200), path: z.string(),
  representation: z.enum(['raw', 'extracted_metadata', 'extracted_download_page']), original_sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const manifestSchema = z.object({
  format: z.literal('safenight-context-mirror-v1'), collected_at: z.iso.datetime(), workflow_run_id: z.string().min(1).max(100),
  sources: z.array(z.object({ id: contextSourceIdSchema, documents: z.array(documentSchema).length(3) }).strict()).length(4),
}).strict();
export class ContextMirrorError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'ContextMirrorError'; this.code = code; }
}
type MirrorManifest = z.infer<typeof manifestSchema>;
type MirrorDocument = z.infer<typeof documentSchema>;
export function parseContextMirrorManifest(value: unknown, now: Date): MirrorManifest {
  const result = manifestSchema.safeParse(value);
  if (!result.success) throw new ContextMirrorError('context_mirror_invalid_manifest');
  const age = now.getTime() - Date.parse(result.data.collected_at);
  if (age < -300000 || age > 36 * 3600000) throw new ContextMirrorError('context_mirror_stale');
  for (const [index, source] of result.data.sources.entries()) {
    if (source.id !== CONTEXT_SOURCE_IDS[index]) throw new ContextMirrorError('context_mirror_source_order');
    const definition = contextDefinitions[source.id];
    const expectedRoles = definition.code === null ? ['metadata', 'download_receipt', 'csv'] : ['metadata', 'download_page', 'csv'];
    if (new Set(source.documents.map(document => document.role)).size !== 3 || expectedRoles.some(role => !source.documents.some(document => document.role === role))) throw new ContextMirrorError('context_mirror_document_roles');
    for (const document of source.documents) {
      if (document.path !== `objects/${document.sha256}.bin`) throw new ContextMirrorError('context_mirror_path_invalid');
      const representation = document.role === 'metadata' ? 'extracted_metadata' : document.role === 'download_page' ? 'extracted_download_page' : 'raw';
      if (document.representation !== representation || (representation === 'raw' && document.original_sha256 !== document.sha256)) throw new ContextMirrorError('context_mirror_representation_invalid');
      const url = new URL(document.official_url);
      if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw new ContextMirrorError('context_mirror_origin_invalid');
      const metadataUrl = `https://www.data.go.kr/data/${definition.dataset}/${definition.code === null ? 'fileData' : 'standard'}.do`;
      switch (document.role) {
        case 'metadata': if (url.href !== metadataUrl) throw new ContextMirrorError('context_mirror_origin_invalid'); break;
        case 'download_receipt': if (url.href !== 'https://www.data.go.kr/tcs/dss/selectFileDataDownload.do') throw new ContextMirrorError('context_mirror_origin_invalid'); break;
        case 'download_page': if (url.href !== 'https://file.localdata.go.kr/file/cctv_info/info') throw new ContextMirrorError('context_mirror_origin_invalid'); break;
        case 'csv':
          if (definition.code === null) {
            if (url.origin !== 'https://www.data.go.kr' || url.pathname !== '/cmm/cmm/fileDownload.do' || !/^FILE_\d+$/.test(url.searchParams.get('atchFileId') ?? '') || !/^\d+$/.test(url.searchParams.get('fileDetailSn') ?? '') || [...url.searchParams.keys()].sort().join(',') !== 'atchFileId,fileDetailSn') throw new ContextMirrorError('context_mirror_origin_invalid');
          } else if (url.href !== `https://file.localdata.go.kr/file/download/cctv_info/info?orgCode=${definition.code}`) throw new ContextMirrorError('context_mirror_origin_invalid');
          break;
      }
    }
  }
  return result.data;
}
function json(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ContextMirrorError('context_mirror_invalid_json'); }
}
async function fetchBytes(path: string, maxBytes: number, fetcher?: typeof globalThis.fetch): Promise<Uint8Array> {
  if (path !== 'manifest.json' && !/^objects\/[a-f0-9]{64}\.bin$/.test(path)) throw new ContextMirrorError('context_mirror_path_invalid');
  try {
    const response = await ky.get(CONTEXT_MIRROR_BASE + path, { fetch: fetcher, timeout: 15000, retry: 0, redirect: 'manual', maxResponseSize: maxBytes, throwHttpErrors: false, headers: { Accept: 'application/octet-stream' } });
    if (!response.ok) throw new ContextMirrorError('context_mirror_http_error');
    if (Number(response.headers.get('Content-Length')) > maxBytes) throw new ContextMirrorError('context_mirror_too_large');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new ContextMirrorError('context_mirror_too_large');
    return bytes;
  } catch (error) {
    if (error instanceof ContextMirrorError) throw error;
    if (error instanceof ResponseSizeError) throw new ContextMirrorError('context_mirror_too_large');
    if (error instanceof TimeoutError) throw new ContextMirrorError('context_mirror_timeout');
    throw new ContextMirrorError('context_mirror_transport_error');
  }
}
const pinnedSchema = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), object_key: z.string() });
async function pinnedManifest(store: CloudContextStore, jobId: string, sourceId: ContextSourceId, now: Date, token: string, fetcher?: typeof globalThis.fetch): Promise<MirrorManifest> {
  const job = await store.get(jobId);
  if (!job) throw new ContextMirrorError('context_mirror_job_missing');
  const validate = (bytes: Uint8Array): MirrorManifest => {
    const manifest = parseContextMirrorManifest(json(bytes), now);
    const collectedDay = new Date(Date.parse(manifest.collected_at) + 9 * 3600000).toISOString().slice(0, 10);
    if (collectedDay !== job.day) throw new ContextMirrorError('context_mirror_not_current_day');
    return manifest;
  };
  const rows = await store.db.prepare("SELECT sha256,object_key FROM context_raw_documents WHERE job_id=? AND role='mirror_manifest' ORDER BY retrieved_at,id LIMIT 2").bind(jobId).all();
  if (rows.results.length > 1) throw new ContextMirrorError('context_mirror_pin_conflict');
  const row = rows.results[0];
  if (row) {
    const pinned = pinnedSchema.parse(row); const object = await store.bucket.get(pinned.object_key);
    if (!object || object.size > MAX_MANIFEST_BYTES) throw new ContextMirrorError('context_mirror_pin_missing');
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (await sha256(bytes) !== pinned.sha256) throw new ContextMirrorError('context_mirror_digest_mismatch');
    return validate(bytes);
  }
  if (sourceId !== CONTEXT_SOURCE_IDS[0]) throw new ContextMirrorError('context_mirror_pin_missing');
  const bytes = await fetchBytes('manifest.json', MAX_MANIFEST_BYTES, fetcher);
  const digest = await sha256(bytes);
  await store.archive(jobId, { source_id: sourceId, role: 'mirror_manifest', url: CONTEXT_MIRROR_BASE + 'manifest.json', bytes, sha256: digest, content_type: 'application/json' }, now, token);
  return validate(bytes);
}
const receiptSchema = z.object({ status: z.literal(true), atchFileId: z.string().regex(/^FILE_\d+$/), fileDetailSn: z.string().regex(/^\d+$/), dataSetFileDetailInfo: z.object({ publicDataPk: z.string(), dataNm: z.string() }).optional() });

export async function downloadPinnedContextMirror(store: CloudContextStore, jobId: string, sourceId: ContextSourceId, now: Date, token: string, fetcher?: typeof globalThis.fetch) {
  const manifest = await pinnedManifest(store, jobId, sourceId, now, token, fetcher);
  const source = manifest.sources.find(source => source.id === sourceId);
  if (!source) throw new ContextMirrorError('context_mirror_source_missing');
  const documents = new Map<MirrorDocument['role'], { document: MirrorDocument; bytes: Uint8Array }>();
  for (const document of source.documents) {
    const bytes = await fetchBytes(document.path, document.size_bytes, fetcher);
    if (bytes.byteLength !== document.size_bytes || await sha256(bytes) !== document.sha256) throw new ContextMirrorError('context_mirror_digest_mismatch');
    await store.archive(jobId, { source_id: sourceId, role: document.role, url: document.official_url, bytes, sha256: document.sha256, content_type: document.content_type }, now, token);
    documents.set(document.role, { document, bytes });
  }
  const metadataRaw = documents.get('metadata'); const csv = documents.get('csv');
  if (!metadataRaw || !csv) throw new ContextMirrorError('context_mirror_source_missing');
  const html = new TextDecoder().decode(metadataRaw.bytes); const metadata = parseContextMetadata(html);
  const definition = contextDefinitions[sourceId];
  if (definition.code === null) {
    const receiptRaw = documents.get('download_receipt');
    const button = html.match(/fn_fileDataDown\('([0-9]+)',\s*'([^']+)',\s*'([^']*)',\s*'([^']+)'/);
    if (!receiptRaw || !button || button[1] !== definition.dataset) throw new ContextMirrorError('context_mirror_chain_invalid');
    const parsed = receiptSchema.safeParse(json(receiptRaw.bytes));
    if (!parsed.success) throw new ContextMirrorError('context_mirror_chain_invalid');
    const receipt = parsed.data; const csvUrl = new URL(csv.document.official_url);
    if (csvUrl.searchParams.get('atchFileId') !== receipt.atchFileId || csvUrl.searchParams.get('fileDetailSn') !== receipt.fileDetailSn || (receipt.dataSetFileDetailInfo && (receipt.dataSetFileDetailInfo.publicDataPk !== definition.dataset || receipt.dataSetFileDetailInfo.dataNm !== metadata.alternateName))) throw new ContextMirrorError('context_mirror_chain_invalid');
  } else {
    const page = documents.get('download_page'); const pageHtml = page ? new TextDecoder().decode(page.bytes) : '';
    if (!pageHtml.includes('data-download-urls="/file/download/cctv_info/info"') || !pageHtml.includes(`value="${definition.code}">서울${definition.district}</option>`)) throw new ContextMirrorError('context_mirror_chain_invalid');
  }
  return parseContextCsv({ source_id: sourceId, bytes: csv.bytes, sha256: csv.document.sha256, metadata, download_url: csv.document.official_url, now: new Date(manifest.collected_at) });
}
