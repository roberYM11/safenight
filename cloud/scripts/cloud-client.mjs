import ky from 'ky';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { readFile, writeFile, rename, realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const ORIGIN = 'https://safenight-seoul-2026.true-tang-8939.chatgpt.site';
const COLLECTION = '/api/internal/collection';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const activeSource = z.enum(['sdot', 'sensor_locations']);
const rawSchema = z.object({ sha: digest, source: z.string().min(1), path: z.string().min(1), bytes: z.number().int().positive() });
const batchSchema = z.object({ page_no: z.number().int().positive(), path: z.string().min(1), rows: z.number().int().min(1).max(200), sha256: digest, bytes: z.number().int().positive() });
const manifestSchema = z.object({
  version: z.literal(1), raw_objects: z.array(rawSchema),
  sources: z.array(z.object({ source: activeSource, day: z.iso.date(), count: z.number().int().nonnegative(), batches: z.array(batchSchema) })),
  backup: z.object({ path: z.string().min(1), sha256: digest, bytes: z.number().int().positive() }),
});
const jobSchema = z.object({
  id: z.string().min(1), source: activeSource, day: z.iso.date(), kind: z.enum(['collect', 'import']),
  status: z.enum(['pending', 'running', 'succeeded', 'failed']), page_no: z.number().int().positive(),
  page_size: z.number().int().positive(), total_count: z.number().int().nonnegative().nullable(),
  fetched_rows: z.number().int().nonnegative(), inserted_rows: z.number().int().nonnegative(),
  error_code: z.string().nullable(),
});
const recordSchema = z.object({
  entity_id: z.string().min(1), observed_at: z.iso.datetime({ offset: true }), published_at: z.iso.datetime({ offset: true }),
  revision_rank: z.number().int().nonnegative(), source_updated_at: z.iso.datetime({ offset: true }).nullable(),
  payload_json: z.string().min(2), lat: z.number().finite().min(-90).max(90).nullable(), lon: z.number().finite().min(-180).max(180).nullable(),
  raw_sha: digest, legacy_id: z.string().nullable(),
});
const progressSchema = z.object({
  version: z.literal(1), origin: z.literal(ORIGIN), manifest_sha256: digest,
  raw_uploaded: z.array(digest), backup_uploaded: z.boolean(),
  jobs: z.record(z.string(), z.string()), completed: z.array(z.string()),
});
const inputSchema = z.object({
  token: z.string().min(32).max(4096), mode: z.enum(['import', 'collect', 'due', 'overview']),
  dataPath: z.string().optional(), day: z.iso.date().optional(), job_id: z.string().optional(),
  maxSteps: z.number().int().min(1).max(10000).default(2000),
  maxSeconds: z.number().int().min(1).max(7200).default(1800),
});

export class ClientFailure extends Error {
  constructor(code, status = 0, serverCode = null) {
    super(code); this.name = 'ClientFailure'; this.code = code; this.status = status; this.serverCode = serverCode;
  }
}
export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export function createClient(token, options = {}) {
  return ky.create({ timeout: 60000, retry: 0, redirect: 'manual', throwHttpErrors: false,
    headers: { 'OAI-Sites-Authorization': `Bearer ${token}`, 'X-SafeNight-Collection-Token': token }, ...options });
}
export async function send(client, path, options = {}) {
  if (!path.startsWith('/api/internal/')) throw new ClientFailure('unsupported_route');
  for (let attempt = 0; attempt < 4; attempt++) {
    let response;
    try { response = await client(`${ORIGIN}${path}`, options); }
    catch (error) {
      if (!(error instanceof Error)) throw error;
      if (attempt === 3) throw new ClientFailure('transport_failed');
      await delay(500 * 2 ** attempt); continue;
    }
    let value;
    try { value = await response.json(); }
    catch (error) { if (error instanceof SyntaxError) throw new ClientFailure('invalid_server_json', response.status); throw error; }
    if (response.ok) return value;
    const parsed = z.object({ error: z.string().regex(/^[a-zA-Z0-9_]{1,100}$/).optional() }).safeParse(value);
    const code = parsed.success ? parsed.data.error ?? null : null;
    const retryable = response.status === 429 || response.status >= 500 || (response.status === 409 && code === 'job_busy');
    if (!retryable || attempt === 3) throw new ClientFailure('http_failed', response.status, code);
    await delay(500 * 2 ** attempt);
  }
  throw new ClientFailure('retry_exhausted');
}
async function dataFile(directory, relative) {
  const parent = await realpath(directory);
  const candidate = await realpath(resolve(parent, relative));
  if (!candidate.startsWith(`${parent}${sep}`)) throw new ClientFailure('data_path_escape');
  const info = await stat(candidate);
  if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new ClientFailure('invalid_data_file');
  return readFile(candidate);
}
async function saveProgress(path, progress) {
  const text = JSON.stringify(progressSchema.parse(progress), null, 2);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, path);
}
function budget(config, state) {
  state.steps += 1;
  if (state.steps > config.maxSteps || Date.now() - state.started > config.maxSeconds * 1000) throw new ClientFailure('run_budget_exhausted');
}
function ensureJob(job) {
  const parsed = jobSchema.parse(job);
  if (parsed.status === 'failed') throw new ClientFailure('job_failed', 0, parsed.error_code);
  return parsed;
}
function logJob(job, event = 'job') {
  console.log(JSON.stringify({ event, job_id: job.id, source: job.source, day: job.day, status: job.status, next_page: job.page_no, fetched_rows: job.fetched_rows, inserted_rows: job.inserted_rows }));
}
async function drive(config, client, initial, state) {
  let job = ensureJob(initial);
  logJob(job, 'start');
  while (job.status !== 'succeeded') {
    budget(config, state);
    job = ensureJob(await send(client, COLLECTION, { method: 'POST', json: { action: 'step', job_id: job.id } }));
    if (job.page_no % 10 === 0 || job.status === 'succeeded') logJob(job);
  }
  return job;
}
export async function importData(config, client, state) {
  if (!config.dataPath) throw new ClientFailure('data_path_required');
  const directory = await realpath(config.dataPath);
  const manifestBytes = await dataFile(directory, 'manifest.json');
  const manifest = manifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
  const manifestHash = sha256(manifestBytes);
  const progressPath = resolve(directory, 'client-progress.json');
  let progress;
  try { progress = progressSchema.parse(JSON.parse(await readFile(progressPath, 'utf8'))); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    progress = { version: 1, origin: ORIGIN, manifest_sha256: manifestHash, raw_uploaded: [], backup_uploaded: false, jobs: {}, completed: [] };
  }
  if (progress.manifest_sha256 !== manifestHash) throw new ClientFailure('progress_manifest_mismatch');
  if (!progress.backup_uploaded) {
    budget(config, state);
    const bytes = await dataFile(directory, manifest.backup.path);
    if (bytes.length !== manifest.backup.bytes || sha256(bytes) !== manifest.backup.sha256) throw new ClientFailure('backup_digest_mismatch');
    const result = z.object({ sha: digest }).parse(await send(client, '/api/internal/raw?source=native_postgres&purpose=backup', { method: 'POST', body: bytes, headers: { 'Content-Type': 'application/gzip', 'Content-Length': String(bytes.length) } }));
    if (result.sha !== manifest.backup.sha256) throw new ClientFailure('uploaded_backup_digest_mismatch');
    progress = { ...progress, backup_uploaded: true }; await saveProgress(progressPath, progress);
    console.log(JSON.stringify({ event: 'backup_uploaded', sha: result.sha, bytes: bytes.length }));
  }
  for (const raw of manifest.raw_objects) {
    if (progress.raw_uploaded.includes(raw.sha)) continue;
    budget(config, state);
    const bytes = await dataFile(directory, raw.path);
    if (bytes.length !== raw.bytes || sha256(bytes) !== raw.sha) throw new ClientFailure('raw_digest_mismatch');
    const query = new URLSearchParams({ source: raw.source });
    if (!activeSource.safeParse(raw.source).success) query.set('purpose', 'backup');
    const result = z.object({ sha: digest }).parse(await send(client, `/api/internal/raw?${query}`, { method: 'POST', body: bytes, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) } }));
    if (result.sha !== raw.sha) throw new ClientFailure('uploaded_raw_digest_mismatch');
    progress = { ...progress, raw_uploaded: [...progress.raw_uploaded, raw.sha] }; await saveProgress(progressPath, progress);
  }
  console.log(JSON.stringify({ event: 'raw_uploaded', count: progress.raw_uploaded.length }));
  const groups = [...manifest.sources].sort((left, right) => Number(left.source !== 'sensor_locations') - Number(right.source !== 'sensor_locations') || left.day.localeCompare(right.day));
  for (const group of groups) {
    const key = `${group.source}:${group.day}`;
    if (progress.completed.includes(key)) continue;
    let job;
    const savedJob = progress.jobs[key];
    if (savedJob) job = ensureJob(await send(client, `${COLLECTION}?job_id=${encodeURIComponent(savedJob)}`));
    else {
      budget(config, state);
      job = ensureJob(await send(client, COLLECTION, { method: 'POST', json: { action: 'start', source: group.source, day: group.day, kind: 'import', expected_count: group.count } }));
      progress = { ...progress, jobs: { ...progress.jobs, [key]: job.id } }; await saveProgress(progressPath, progress);
    }
    logJob(job, 'import_start');
    for (const batch of group.batches) {
      if (job.status === 'succeeded' || batch.page_no < job.page_no) continue;
      if (batch.page_no !== job.page_no) throw new ClientFailure('import_cursor_mismatch');
      budget(config, state);
      const bytes = await dataFile(directory, batch.path);
      if (bytes.length !== batch.bytes || sha256(bytes) !== batch.sha256) throw new ClientFailure('batch_digest_mismatch');
      const records = z.array(recordSchema).parse(JSON.parse(bytes.toString('utf8')));
      if (records.length !== batch.rows) throw new ClientFailure('batch_count_mismatch');
      job = ensureJob(await send(client, '/api/internal/import', { method: 'POST', json: { job_id: job.id, page_no: batch.page_no, records } }));
      if (job.page_no % 10 === 0 || job.status === 'succeeded') logJob(job, 'import');
    }
    if (job.status !== 'succeeded' && job.total_count !== null && job.fetched_rows === job.total_count) {
      budget(config, state);
      job = ensureJob(await send(client, COLLECTION, { method: 'POST', json: { action: 'finalize', job_id: job.id } }));
    }
    if (job.status !== 'succeeded') throw new ClientFailure('import_not_complete');
    progress = { ...progress, completed: [...progress.completed, key] }; await saveProgress(progressPath, progress);
  }
  return send(client, COLLECTION);
}
export async function run(config, client = createClient(config.token)) {
  const state = { started: Date.now(), steps: 0 };
  switch (config.mode) {
    case 'overview': return send(client, COLLECTION);
    case 'import': return importData(config, client, state);
    case 'collect': {
      let initial;
      if (config.job_id) initial = await send(client, `${COLLECTION}?job_id=${encodeURIComponent(config.job_id)}`);
      else {
        if (!config.day) throw new ClientFailure('day_required');
        initial = await send(client, COLLECTION, { method: 'POST', json: { action: 'start', source: 'sdot', day: config.day, kind: 'collect' } });
      }
      await drive(config, client, initial, state); return send(client, COLLECTION);
    }
    case 'due': {
      const seen = new Set();
      while (true) {
        budget(config, state);
        const planned = z.object({ plan: z.object({ status: z.enum(['ready', 'retry_deferred', 'archive_backfill_required']) }).passthrough(), job: jobSchema.nullable() }).parse(await send(client, COLLECTION, { method: 'POST', json: { action: 'due' } }));
        if (planned.job === null) {
          if (planned.plan.status !== 'ready') throw new ClientFailure(`due_${planned.plan.status}`);
          return { plan: planned.plan, overview: await send(client, COLLECTION), steps: state.steps };
        }
        if (seen.has(planned.job.id)) throw new ClientFailure('due_plan_repeated_job');
        seen.add(planned.job.id); await drive(config, client, planned.job, state);
      }
    }
    default: throw new ClientFailure('unsupported_mode');
  }
}
async function main() {
  process.stdin.setEncoding('utf8');
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const config = inputSchema.parse(JSON.parse(input));
  const result = await run(config);
  console.log(JSON.stringify({ event: 'complete', mode: config.mode, result }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    if (error instanceof ClientFailure) console.error(JSON.stringify({ error: error.code, status: error.status, server_code: error.serverCode }));
    else if (error instanceof z.ZodError || error instanceof SyntaxError) console.error(JSON.stringify({ error: 'invalid_input_or_payload' }));
    else console.error(JSON.stringify({ error: 'unexpected_client_failure' }));
    process.exitCode = 1;
  });
}
