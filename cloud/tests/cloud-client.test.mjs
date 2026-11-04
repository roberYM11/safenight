import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, importData, run, send, sha256 } from '../scripts/cloud-client.mjs';
const TOKEN = 'fixture-only-token-never-a-real-credential';
const job = (source, status = 'pending', page_no = 1) => ({ id: `job-${source}`, source, day: '2026-11-03', kind: 'import', status, page_no, page_size: 200, total_count: 1, fetched_rows: status === 'succeeded' ? 1 : 0, inserted_rows: status === 'succeeded' ? 1 : 0, error_code: null });
const config = { token: TOKEN, mode: 'import', maxSteps: 100, maxSeconds: 10 };

test('imports backups and raw bytes before positions and S-DoT, then resumes without duplicate writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'safenight-cloud-client-'));
  try {
    const raws = await Promise.all(['sdot', 'sensor_locations', 'cctv'].map(async source => {
      const bytes = Buffer.from(`raw-${source}`); const path = `${source}.bin`;
      await writeFile(join(directory, path), bytes);
      return { source, path, sha: sha256(bytes), bytes: bytes.length };
    }));
    const groups = await Promise.all(['sdot', 'sensor_locations'].map(async source => {
      const raw = raws.find(row => row.source === source);
      const records = [{ entity_id: 'sensor1', observed_at: '2026-11-03T00:00:00.000Z', published_at: '2026-11-03T00:00:00.000Z', revision_rank: 1, source_updated_at: null, payload_json: '{}', lat: null, lon: null, raw_sha: raw.sha, legacy_id: 'original-revision' }];
      const bytes = Buffer.from(JSON.stringify(records)); const path = `${source}.json`;
      await writeFile(join(directory, path), bytes);
      return { source, day: '2026-11-03', count: 1, batches: [{ page_no: 1, path, rows: 1, bytes: bytes.length, sha256: sha256(bytes) }] };
    }));
    const backup = Buffer.from('fixture-sql-backup'); await writeFile(join(directory, 'public.sql.gz'), backup);
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ version: 1, raw_objects: raws, sources: groups, backup: { path: 'public.sql.gz', sha256: sha256(backup), bytes: backup.length } }));
    const requests = [];
    const client = createClient(TOKEN, { fetch: async request => {
      assert.equal(request.headers.get('X-SafeNight-Collection-Token'), TOKEN);
      assert.equal(request.headers.get('OAI-Sites-Authorization'), `Bearer ${TOKEN}`);
      const url = new URL(request.url); assert.equal(url.origin, 'https://safenight-seoul-2026.true-tang-8939.chatgpt.site');
      if (url.pathname.endsWith('/raw')) {
        const bytes = new Uint8Array(await request.arrayBuffer());
        requests.push(`raw:${url.searchParams.get('source')}:${url.searchParams.get('purpose') ?? 'active'}`);
        return Response.json({ sha: sha256(bytes) });
      }
      if (request.method === 'GET') { requests.push('overview'); return Response.json({ revisions: 2 }); }
      const input = await request.json();
      if (url.pathname.endsWith('/import')) {
        requests.push(`import:${input.job_id}`); return Response.json(job(input.job_id.replace('job-', ''), 'succeeded', 2));
      }
      requests.push(`start:${input.source}`); return Response.json(job(input.source));
    } });
    const result = await importData({ ...config, dataPath: directory }, client, { started: Date.now(), steps: 0 });
    assert.equal(result.revisions, 2);
    assert.deepEqual(requests.slice(0, 4), ['raw:native_postgres:backup', 'raw:sdot:active', 'raw:sensor_locations:active', 'raw:cctv:backup']);
    assert.deepEqual(requests.slice(4, 8), ['start:sensor_locations', 'import:job-sensor_locations', 'start:sdot', 'import:job-sdot']);
    const progressText = await readFile(join(directory, 'client-progress.json'), 'utf8');
    assert.equal(progressText.includes(TOKEN), false);
    assert.equal(JSON.parse(progressText).completed.length, 2);
    const count = requests.length;
    await importData({ ...config, dataPath: directory }, client, { started: Date.now(), steps: 0 });
    assert.deepEqual(requests.slice(count), ['overview']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('refuses a manifest path escaping the export directory before any upload', async () => {
  const base = await mkdtemp(join(tmpdir(), 'safenight-cloud-path-'));
  const directory = join(base, 'data');
  const { mkdir } = await import('node:fs/promises'); await mkdir(directory);
  try {
    await writeFile(join(base, 'outside.bin'), 'private');
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ version: 1, raw_objects: [], sources: [], backup: { path: '../outside.bin', sha256: sha256('private'), bytes: 7 } }));
    let calls = 0;
    const client = createClient(TOKEN, { fetch: async () => { calls++; return Response.json({}); } });
    await assert.rejects(importData({ ...config, dataPath: directory }, client, { started: Date.now(), steps: 0 }), { code: 'data_path_escape' });
    assert.equal(calls, 0);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('finalizes a fully staged running import on resume without resubmitting observations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'safenight-cloud-resume-'));
  try {
    // Given: the last batch was persisted before the publisher connection failed.
    const records = [{ entity_id: 'sensor1', observed_at: '2026-11-03T00:00:00.000Z', published_at: '2026-11-03T00:00:00.000Z', revision_rank: 1, source_updated_at: null, payload_json: '{}', lat: null, lon: null, raw_sha: sha256('raw-sdot'), legacy_id: 'original-revision' }];
    const bytes = Buffer.from(JSON.stringify(records));
    await writeFile(join(directory, 'batch.json'), bytes);
    const manifestBytes = Buffer.from(JSON.stringify({ version: 1, raw_objects: [], sources: [{ source: 'sdot', day: '2026-11-03', count: 1, batches: [{ page_no: 1, path: 'batch.json', rows: 1, bytes: bytes.length, sha256: sha256(bytes) }] }], backup: { path: 'public.sql.gz', sha256: sha256('backup'), bytes: 6 } }));
    await writeFile(join(directory, 'manifest.json'), manifestBytes);
    await writeFile(join(directory, 'client-progress.json'), JSON.stringify({ version: 1, origin: 'https://safenight-seoul-2026.true-tang-8939.chatgpt.site', manifest_sha256: sha256(manifestBytes), raw_uploaded: [], backup_uploaded: true, jobs: { 'sdot:2026-11-03': 'job-sdot' }, completed: [] }));
    const requests = [];
    const client = createClient(TOKEN, { fetch: async request => {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.searchParams.get('job_id') === 'job-sdot') {
        requests.push('resume');
        return Response.json({ ...job('sdot', 'running', 2), fetched_rows: 1, inserted_rows: 1 });
      }
      if (request.method === 'GET' && url.pathname.endsWith('/collection')) {
        requests.push('overview'); return Response.json({ revisions: 1 });
      }
      const input = await request.json();
      assert.equal(url.pathname, '/api/internal/collection');
      assert.deepEqual(input, { action: 'finalize', job_id: 'job-sdot' });
      requests.push('finalize');
      return Response.json(job('sdot', 'succeeded', 2));
    } });

    // When: the importer resumes from its secret-free progress file.
    const result = await importData({ ...config, dataPath: directory }, client, { started: Date.now(), steps: 0 });

    // Then: publication completes without a new import batch or provider request.
    assert.equal(result.revisions, 1);
    assert.deepEqual(requests, ['resume', 'finalize', 'overview']);
    const progressText = await readFile(join(directory, 'client-progress.json'), 'utf8');
    assert.deepEqual(JSON.parse(progressText).completed, ['sdot:2026-11-03']);
    assert.equal(progressText.includes(TOKEN), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('does not retry an unauthorized write or expose response data', async () => {
  let calls = 0;
  const client = createClient(TOKEN, { fetch: async () => { calls++; return Response.json({ error: 'unauthorized', secret: TOKEN }, { status: 401 }); } });
  await assert.rejects(send(client, '/api/internal/collection'), error => error.code === 'http_failed' && error.status === 401 && !error.message.includes(TOKEN));
  assert.equal(calls, 1);
});

test('reports a deferred due plan instead of claiming successful collection', async () => {
  const client = createClient(TOKEN, { fetch: async () => Response.json({ plan: { status: 'retry_deferred' }, job: null }) });
  await assert.rejects(run({ ...config, mode: 'due' }, client), { code: 'due_retry_deferred' });
});

test('stops a nonterminal collect job at its configured step budget', async () => {
  let pages = 0;
  const client = createClient(TOKEN, { fetch: async request => {
    const input = await request.json();
    const response = { ...job('sdot', 'running', pages + 1), kind: 'collect' };
    if (input.action === 'step') pages++;
    return Response.json(response);
  } });
  await assert.rejects(run({ ...config, mode: 'collect', day: '2026-11-03', maxSteps: 1 }, client), { code: 'run_budget_exhausted' });
  assert.equal(pages, 1);
});
