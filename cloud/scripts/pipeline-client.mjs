import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient, send, run, ClientFailure, sha256 } from './cloud-client.mjs';

const PIPELINE = '/api/internal/pipeline';
export async function drain(client, maxSteps = 2000) {
  for (let step = 0; step < maxSteps; step++) {
    const result = await send(client, PIPELINE, { method: 'POST', json: { action: 'step' } });
    if (result.status === 'idle') return { status: 'idle', steps: step };
    if (result.status === 'busy') throw new ClientFailure('derivation_busy');
  }
  throw new ClientFailure('derivation_budget_exhausted');
}
export async function mirror(client, expectedManifestSha) {
  let job = await send(client, '/api/internal/context', { method: 'POST', json: { action: 'due' } });
  for (let steps = 0; job.status === 'running' && steps < 5; steps++) {
    job = await send(client, '/api/internal/context', { method: 'POST', json: { action: 'mirror_step', job_id: job.id, expected_manifest_sha256: expectedManifestSha } });
  }
  if (job.status !== 'succeeded') throw new ClientFailure('context_not_published');
  const [overview, verified] = await Promise.all([
    send(client, '/api/internal/context'), send(client, `/api/internal/context?job_id=${encodeURIComponent(job.id)}`),
  ]);
  if (overview.current?.id !== job.snapshot_id || (expectedManifestSha && verified.mirror_manifest_sha256 !== expectedManifestSha)) throw new ClientFailure('context_manifest_mismatch');
  return { snapshot_id: job.snapshot_id, mirror_manifest_sha256: verified.mirror_manifest_sha256 };
}
export async function runPipeline(mode, token, options = {}, client = createClient(token, { headers: { 'OAI-Sites-Authorization': `Bearer ${options.siteToken || token}`, 'X-SafeNight-Collection-Token': token } })) {
  switch (mode) {
    case 'collect': {
      await send(client, PIPELINE, { method: 'POST', json: { action: 'bootstrap' } });
      await run({ token, mode: 'due', maxSteps: 5000, maxSeconds: 5400 }, client);
      return drain(client, options.maxSteps ?? 10000);
    }
    case 'derive': await send(client, PIPELINE, { method: 'POST', json: { action: 'bootstrap' } }); return drain(client, options.maxSteps ?? 10000);
    case 'context': return mirror(client, options.expectedManifestSha);
    default: throw new ClientFailure('unsupported_pipeline_mode');
  }
}
async function main() {
  const token = process.env.SAFENIGHT_COLLECT_AUTH_TOKEN;
  if (!token || token.length < 32) throw new ClientFailure('collection_token_missing');
  const manifest = process.env.SAFENIGHT_MIRROR_MANIFEST;
  const result = await runPipeline(process.argv[2] ?? 'collect', token, { siteToken: process.env.SAFENIGHT_SITE_BYPASS_TOKEN, expectedManifestSha: manifest ? sha256(await readFile(manifest)) : undefined });
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { // no-excuse-ok: catch
    console.error(JSON.stringify({ error: error instanceof ClientFailure ? error.code : 'pipeline_client_failed' }));
    process.exitCode = 1;
  });
}
