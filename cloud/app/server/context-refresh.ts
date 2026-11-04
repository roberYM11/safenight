import ky, { NetworkError, ResponseSizeError, TimeoutError } from 'ky';
import { z } from 'zod';
import { ContextRefreshError, contextDefinitions, contextSourceIdSchema, parseContextMetadata, parseContextCsv } from './context-source-parser.ts';
import type { ContextSourceId } from './context-source-parser.ts';
import type { ContextDataset } from './context-data.ts';
export { CONTEXT_SOURCE_IDS, ContextRefreshError, contextSourceIdSchema } from './context-source-parser.ts';
export type { ContextSourceId } from './context-source-parser.ts';

const MAX_BYTES = 10 * 1024 * 1024;
const PAGE_BYTES = 1024 * 1024;
const HOSTS = new Set(['www.data.go.kr', 'file.localdata.go.kr']);
export type ContextRawDocument = Readonly<{
  source_id: ContextSourceId; role: 'metadata' | 'download_page' | 'download_receipt' | 'csv';
  url: string; bytes: Uint8Array; sha256: string; content_type: string;
}>;
export type ContextDownloadOptions = Readonly<{
  fetcher?: typeof globalThis.fetch; archive?: (document: ContextRawDocument) => Promise<void>;
}>;

/** Fixed public targets only: compare production egress without exposing provider bodies or creating a proxy. */
export async function probeContextConnectivity(fetcher?: typeof globalThis.fetch) {
  const targets = [
    { id: 'portal_html', url: 'https://www.data.go.kr/data/15097746/fileData.do' },
    { id: 'portal_catalog', url: 'https://www.data.go.kr/catalog/15097746/fileData.json' },
    { id: 'portal_root_host', url: 'https://data.go.kr/data/15097746/fileData.do' },
    { id: 'localdata_page', url: 'https://file.localdata.go.kr/file/cctv_info/info' },
    { id: 'github_raw', url: 'https://raw.githubusercontent.com/github/gitignore/main/README.md' },
  ];
  return Promise.all(targets.map(async target => {
    const started = performance.now();
    try {
      const response = await ky.get(target.url, { fetch: fetcher, retry: 0, timeout: 6000, redirect: 'manual', throwHttpErrors: false, maxResponseSize: PAGE_BYTES,
        headers: { 'User-Agent': 'Mozilla/5.0 SafeNight-public-data-refresh', Referer: 'https://www.data.go.kr/' },
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { target: target.id, status: response.status, bytes: bytes.byteLength, elapsed_ms: Math.round(performance.now() - started), error: null };
    } catch (error) {
      const code = error instanceof TimeoutError ? 'source_timeout' : error instanceof ResponseSizeError ? 'source_too_large' : 'source_transport_error';
      return { target: target.id, status: null, bytes: null, elapsed_ms: Math.round(performance.now() - started), error: code };
    }
  }));
}

async function requestDocument(sourceId: ContextSourceId, role: ContextRawDocument['role'], url: string, options: ContextDownloadOptions, body?: URLSearchParams): Promise<ContextRawDocument> {
  const target = new URL(url);
  if (target.protocol !== 'https:' || !HOSTS.has(target.hostname) || target.port || target.username || target.password) throw new ContextRefreshError('source_download_changed');
  let response: Response;
  try {
    response = await ky(url, { method: body ? 'POST' : 'GET', body, fetch: options.fetcher, retry: 0, timeout: 15000, redirect: 'manual', throwHttpErrors: false, maxResponseSize: role === 'csv' ? MAX_BYTES : PAGE_BYTES,
      headers: { 'User-Agent': 'Mozilla/5.0 SafeNight-public-data-refresh', Referer: 'https://www.data.go.kr/' },
    });
  } catch (error) {
    if (error instanceof TimeoutError) throw new ContextRefreshError('source_timeout');
    if (error instanceof ResponseSizeError) throw new ContextRefreshError('source_too_large');
    if (error instanceof NetworkError || error instanceof TypeError) throw new ContextRefreshError('source_transport_error');
    throw error;
  }
  const maxBytes = role === 'csv' ? MAX_BYTES : PAGE_BYTES;
  if (Number(response.headers.get('Content-Length')) > maxBytes) throw new ContextRefreshError('source_too_large');
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await response.arrayBuffer()); }
  catch (error) {
    if (error instanceof ResponseSizeError) throw new ContextRefreshError('source_too_large');
    throw error;
  }
  if (bytes.byteLength > maxBytes) throw new ContextRefreshError('source_too_large');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
  const sha256 = Array.from(digest, value => value.toString(16).padStart(2, '0')).join('');
  const document = { source_id: sourceId, role, url, bytes, sha256, content_type: response.headers.get('Content-Type') ?? 'application/octet-stream' };
  await options.archive?.(document);
  if (!response.ok) throw new ContextRefreshError('source_http_error');
  return document;
}
const receiptSchema = z.object({ status: z.literal(true), atchFileId: z.string().regex(/^FILE_\d+$/), fileDetailSn: z.string().regex(/^\d+$/) });

/** One bounded public source per call. Archive bytes before parsing; publishing belongs to the coordinator. */
export async function downloadContextSource(sourceId: ContextSourceId, now: Date, options: ContextDownloadOptions = {}): Promise<ContextDataset> {
  const parsedSource = contextSourceIdSchema.safeParse(sourceId);
  if (!parsedSource.success) throw new ContextRefreshError('invalid_source');
  const definition = contextDefinitions[parsedSource.data];
  const metadataUrl = `https://www.data.go.kr/data/${definition.dataset}/${definition.code === null ? 'fileData' : 'standard'}.do`;
  const metadataDocument = await requestDocument(sourceId, 'metadata', metadataUrl, options);
  const html = new TextDecoder().decode(metadataDocument.bytes);
  const metadata = parseContextMetadata(html);
  let downloadUrl: string;
  if (definition.code === null) {
    const button = html.match(/fn_fileDataDown\('([0-9]+)',\s*'([^']+)',\s*'([^']*)',\s*'([^']+)'/);
    if (!button || button[1] !== definition.dataset || !/^uddi:[0-9a-f-]+$/i.test(button[2]) || !/^\d+$/.test(button[4])) throw new ContextRefreshError('source_download_changed');
    const body = new URLSearchParams({ publicDataPk: button[1], publicDataDetailPk: button[2], atchFileId: button[3], fileDetailSn: button[4], publicDataTyCode: 'PR0051' });
    const receiptDocument = await requestDocument(sourceId, 'download_receipt', 'https://www.data.go.kr/tcs/dss/selectFileDataDownload.do', options, body);
    let receiptValue: unknown;
    try { receiptValue = JSON.parse(new TextDecoder().decode(receiptDocument.bytes)); } catch { throw new ContextRefreshError('source_download_changed'); }
    const receipt = receiptSchema.safeParse(receiptValue);
    if (!receipt.success) throw new ContextRefreshError('source_download_changed');
    downloadUrl = `https://www.data.go.kr/cmm/cmm/fileDownload.do?${new URLSearchParams({ atchFileId: receipt.data.atchFileId, fileDetailSn: receipt.data.fileDetailSn })}`;
  } else {
    const page = await requestDocument(sourceId, 'download_page', 'https://file.localdata.go.kr/file/cctv_info/info', options);
    const pageHtml = new TextDecoder().decode(page.bytes);
    if (!pageHtml.includes('data-download-urls="/file/download/cctv_info/info"') || !pageHtml.includes(`value="${definition.code}">서울${definition.district}</option>`)) throw new ContextRefreshError('source_download_changed');
    downloadUrl = `https://file.localdata.go.kr/file/download/cctv_info/info?orgCode=${definition.code}`;
  }
  const raw = await requestDocument(sourceId, 'csv', downloadUrl, options);
  return parseContextCsv({ source_id: sourceId, bytes: raw.bytes, sha256: raw.sha256, metadata, download_url: downloadUrl, now });
}
