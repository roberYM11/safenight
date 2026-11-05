import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ky from 'ky';
import { z } from 'zod';
import { ClientFailure, createClient, send, sha256 } from './cloud-client.mjs';

export const CATALOG = 'https://data.seoul.go.kr/dataList/OA-22833/A/1/datasetView.do';
export const DOWNLOAD = 'https://datafile.seoul.go.kr/bigfile/iot/inf/nio_download.do?useCache=false';
const collection = '/api/internal/collection';
const providerClient = ky.create({ timeout: 30_000, retry: 1, redirect: 'error' });
const python = fileURLToPath(new URL('../../backend/.venv/bin/python', import.meta.url));
const normalizer = fileURLToPath(new URL('../../backend/scripts/prepare_locations.py', import.meta.url));
const jobSchema = z.object({
  id: z.string().min(1), source: z.literal('sensor_locations'), day: z.iso.date(), kind: z.literal('import'),
  status: z.enum(['pending', 'running', 'succeeded']), page_no: z.number().int().positive(),
  page_size: z.literal(200), total_count: z.number().int().positive(), fetched_rows: z.number().int().nonnegative(),
  created_at: z.iso.datetime(),
});

// The catalogue provides the file's modification day and a separate numeric download selector.
// Never execute provider JavaScript or follow a URL supplied by the HTML.
export function discoverWorkbook(html) {
  const matches = [];
  for (const [row] of html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)) {
    if (!/title="[^"]*S-DoT[^"]*설치\s*위치정보[^"]*\.xlsx"/i.test(row)) continue;
    const seq = /\bdownloadFile\(\s*'(\d{1,20})'\s*\)/.exec(row)?.[1];
    const stamp = /<td\b[^>]*>\s*(\d{4})\.(\d{2})\.(\d{2})\.\s*<\/td>/i.exec(row);
    if (!seq || !stamp) throw new ClientFailure('invalid_location_catalog');
    matches.push({ seq, day: z.iso.date().parse(stamp.slice(1).join('-')) });
  }
  matches.sort((a, b) => b.day.localeCompare(a.day));
  if (!matches[0] || matches.some(item => item.day === matches[0].day && item.seq !== matches[0].seq)) {
    throw new ClientFailure('location_file_missing_or_ambiguous');
  }
  return matches[0];
}

export async function syncLocations(client, provider = providerClient) {
  const catalog = await provider.get(CATALOG, { maxResponseSize: 4 * 1024 * 1024 }).text();
  const { seq, day } = discoverWorkbook(catalog);
  const body = new URLSearchParams({ infId: 'OA-22833', infSeq: '3', seq, seqNo: '' });
  const bytes = Buffer.from(await provider.post(DOWNLOAD, { body, maxResponseSize: 8 * 1024 * 1024 }).arrayBuffer());
  const digest = sha256(bytes);
  const decoded = execFileSync(python, [normalizer], { input: bytes, maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const points = z.array(z.object({ sensor_id: z.string().min(1), lat: z.number().finite(), lon: z.number().finite() }))
    .min(1).max(500000).parse(JSON.parse(decoded));
  let job = jobSchema.parse(await send(client, collection, { method: 'POST', json: {
    action: 'sync_locations', day, expected_count: points.length, location_sha256: digest,
  } }));
  if (job.day !== day || job.total_count !== points.length) throw new ClientFailure('location_job_mismatch');
  const result = { day, sha256: digest, sensors: points.length, job_id: job.id };
  if (job.status === 'succeeded') return { status: 'unchanged', ...result };
  // A deployment with the old import contract cannot safely resume a digest-bound job.
  if (!job.id.startsWith(`loc:${digest}:`)) throw new ClientFailure('location_digest_protocol_required');
  const raw = await send(client, '/api/internal/raw?source=sensor_locations', { method: 'POST', body: bytes,
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) } });
  if (raw.sha !== digest) throw new ClientFailure('uploaded_raw_digest_mismatch');

  const observedAt = new Date(`${day}T00:00:00+09:00`).toISOString();
  const publishedAt = job.created_at;
  // Two revisions to the same dated file are ordered by their first verified receipt.
  const rank = Date.parse(publishedAt);
  while (job.fetched_rows < points.length) {
    const start = (job.page_no - 1) * job.page_size;
    if (job.fetched_rows !== start) throw new ClientFailure('location_cursor_mismatch');
    const records = points.slice(start, start + job.page_size).map(point => ({
      entity_id: point.sensor_id, observed_at: observedAt, published_at: publishedAt, revision_rank: rank,
      source_updated_at: null, payload_json: JSON.stringify(point), lat: point.lat, lon: point.lon, raw_sha: digest,
    }));
    const next = jobSchema.parse(await send(client, '/api/internal/import', { method: 'POST',
      json: { job_id: job.id, page_no: job.page_no, records } }));
    if (next.id !== job.id || next.fetched_rows <= job.fetched_rows || next.fetched_rows > points.length) throw new ClientFailure('location_cursor_mismatch');
    job = next;
  }
  if (job.status !== 'succeeded') job = jobSchema.parse(await send(client, collection, { method: 'POST', json: { action: 'finalize', job_id: job.id } }));
  if (job.status !== 'succeeded' || job.id !== result.job_id || job.fetched_rows !== points.length) throw new ClientFailure('location_publish_incomplete');
  return { status: 'published', ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const token = z.string().min(32).max(4096).parse(process.env.SAFENIGHT_COLLECT_AUTH_TOKEN);
    const client = createClient(token, { headers: { 'OAI-Sites-Authorization': `Bearer ${process.env.SAFENIGHT_SITE_BYPASS_TOKEN || token}`,
      'X-SafeNight-Collection-Token': token } });
    console.log(JSON.stringify(await syncLocations(client)));
  } catch (error) {
    console.error(JSON.stringify({ error: error instanceof ClientFailure ? error.code : 'location_source_or_sync_failure' }));
    process.exitCode = 1;
  }
}
