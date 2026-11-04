import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createClient, send, sha256, ORIGIN, ClientFailure } from './cloud-client.mjs';

const execute = promisify(execFile);
const PIPELINE = '/api/internal/pipeline';
async function main() {
  const token = process.env.SAFENIGHT_COLLECT_AUTH_TOKEN;
  const codeSha = process.env.GITHUB_SHA;
  if (!token || token.length < 32 || !codeSha) throw new ClientFailure('training_environment_missing');
  const client = createClient(token, { headers: { 'OAI-Sites-Authorization': `Bearer ${process.env.SAFENIGHT_SITE_BYPASS_TOKEN || token}`, 'X-SafeNight-Collection-Token': token } });
  const planned = await send(client, PIPELINE, { method: 'POST', json: { action: 'train_next', code_sha: codeSha } });
  if (planned.status !== 'running') { console.log(JSON.stringify(planned)); return; }
  const directory = await mkdtemp(join(tmpdir(), 'safenight-training-'));
  try {
    const response = await client(`${ORIGIN}${PIPELINE}?dataset_id=${encodeURIComponent(planned.dataset_id)}`);
    if (!response.ok) throw new ClientFailure('dataset_download_failed');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (sha256(bytes) !== planned.dataset_id) throw new ClientFailure('dataset_download_digest_mismatch');
    const snapshot = join(directory, 'dataset.json'); await writeFile(snapshot, bytes);
    const script = fileURLToPath(new URL('../../backend/scripts/train_pipeline.py', import.meta.url));
    const backend = fileURLToPath(new URL('../../backend/', import.meta.url));
    const result = await execute('uv', ['run', '--locked', 'python', script, '--snapshot', snapshot, '--output', join(directory, 'model')], { cwd: backend, maxBuffer: 32 * 1024 * 1024, timeout: 30 * 60 * 1000 });
    const candidate = z.object({ model_text: z.string(), manifest_text: z.string(), evaluations: z.array(z.unknown()) }).parse(JSON.parse(result.stdout));
    const recorded = await send(client, PIPELINE, { method: 'POST', json: { action: 'candidate', run_id: planned.run_id, ...candidate } });
    console.log(JSON.stringify({ status: recorded.status, model_version: recorded.model_version, report: recorded.report }));
    if (process.argv.includes('--promote')) {
      if (!recorded.report?.passed) throw new ClientFailure('model_quality_gate_failed');
      const actor = process.env.GITHUB_ACTOR || 'operator';
      await send(client, PIPELINE, { method: 'POST', json: { action: 'approve', version: recorded.model_version, actor } });
      const overview = await send(client, PIPELINE);
      const generation = overview.active_models.find(row => row.name === 'environment')?.generation ?? 0;
      await send(client, PIPELINE, { method: 'POST', json: { action: 'activate', version: recorded.model_version, expected_generation: generation, actor, reason: 'explicit workflow promotion after frozen sensor/time/region evaluation' } });
    }
  } catch (error) {
    await send(client, PIPELINE, { method: 'POST', json: { action: 'training_failed', run_id: planned.run_id, code: 'training_worker_failed' } });
    throw error;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { // no-excuse-ok: catch
    console.error(JSON.stringify({ error: error instanceof ClientFailure ? error.code : 'training_worker_failed' }));
    process.exitCode = 1;
  });
}
