import { z } from 'zod';
import { authorizedCollection } from '../cloud/auth.ts';
import { ArtifactError } from '../forest.ts';
import { bootstrapHistory, deriveStep } from './derive.ts';
import { beginTraining, buildDataset, labelRequestSchema, registerLabels } from './datasets.ts';
import { candidateSchema } from './evaluation.ts';
import { ModelRegistry } from './models.ts';
import { PipelineError, readBytes } from './objects.ts';
import { finishTraining } from './training.ts';

const command = z.discriminatedUnion('action', [
  z.object({ action: z.literal('bootstrap') }).strict(), z.object({ action: z.literal('step') }).strict(),
  z.object({ action: z.literal('labels'), ...labelRequestSchema.shape }).strict(),
  z.object({ action: z.literal('train_next'), code_sha: z.string().regex(/^[a-f0-9]{40,64}$/), target_version: z.string().max(100).optional() }).strict(),
  z.object({ action: z.literal('candidate'), ...candidateSchema.shape }).strict(),
  z.object({ action: z.literal('training_failed'), run_id: z.string(), code: z.string().regex(/^[a-z_]{1,80}$/) }).strict(),
  z.object({ action: z.literal('approve'), version: z.string().max(120), actor: z.string().min(1).max(100) }).strict(),
  z.object({ action: z.literal('activate'), version: z.string().max(120), expected_generation: z.number().int().nonnegative(), actor: z.string().min(1).max(100), reason: z.string().min(1).max(500) }).strict(),
]);
export type PipelineEnvironment = { readonly db: D1Database; readonly bucket: R2Bucket; readonly token: string | undefined; readonly modelText: string; readonly manifestText: string; readonly clock?: () => Date };
const headers = { 'Cache-Control': 'no-store' } as const;
async function body(request: Request): Promise<unknown> {
  const max = 32 * 1024 * 1024;
  if (Number(request.headers.get('Content-Length')) > max) throw new PipelineError('request_too_large');
  if (!request.body) throw new PipelineError('invalid_command');
  const reader = request.body.getReader(); const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > max) { await reader.cancel(); throw new PipelineError('request_too_large'); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

/** Authentication, bounded parsing and domain errors share one boundary for routes and Worker tests. */
export async function pipelineHttp(request: Request, environment: PipelineEnvironment): Promise<Response> {
  if (!await authorizedCollection(request, environment.token)) return Response.json({ error: 'unauthorized' }, { status: 401, headers });
  const { db, bucket } = environment;
  const clock = environment.clock ?? (() => new Date()); const now = clock();
  const registry = new ModelRegistry(db, bucket);
  try {
    if (request.method === 'GET') {
      const params = new URL(request.url).searchParams;
      const featureCursor = params.get('features_after');
      if (featureCursor !== null) {
        if (featureCursor !== '' && !/^[a-f0-9]{64}$/.test(featureCursor)) throw new PipelineError('invalid_feature_cursor');
        const rows = z.array(z.object({ id: z.string(), entity_id: z.string(), as_of: z.string(), available_cutoff: z.string(), observation_revision_id: z.string(), location_revision_id: z.string(), payload_json: z.string() }))
          .parse((await db.prepare('SELECT id,entity_id,as_of,available_cutoff,observation_revision_id,location_revision_id,payload_json FROM feature_snapshots WHERE id>? ORDER BY id LIMIT 200').bind(featureCursor).all()).results);
        return Response.json({ features: rows.map(({ payload_json, ...row }) => ({ ...row, feature: JSON.parse(payload_json) })), next_cursor: rows.length === 200 ? rows[rows.length - 1].id : null }, { headers });
      }
      const datasetId = params.get('dataset_id');
      if (datasetId) {
        if (!/^[a-f0-9]{64}$/.test(datasetId)) throw new PipelineError('invalid_dataset_id');
        const row = await db.prepare('SELECT object_key,sha256 FROM dataset_snapshots WHERE id=?').bind(datasetId).first<{ object_key: string; sha256: string }>();
        if (!row) throw new PipelineError('dataset_missing');
        const bytes = await readBytes(bucket, row.object_key, row.sha256);
        return new Response(Uint8Array.from(bytes), { headers: { ...headers, 'Content-Type': 'application/json', 'X-Content-SHA256': row.sha256 } });
      }
      const counts = await db.prepare(`SELECT
        (SELECT COUNT(*) FROM derivation_jobs WHERE status IN ('pending','running')) pending_jobs,
        (SELECT COUNT(*) FROM feature_snapshots) features,(SELECT COUNT(*) FROM prediction_results) predictions,
        (SELECT COUNT(*) FROM target_values) targets,(SELECT COUNT(*) FROM dataset_snapshots) datasets`).first();
      const active = await db.prepare('SELECT * FROM active_models').all();
      return Response.json({ counts, active_models: active.results }, { headers });
    }
    if (request.method !== 'POST') return Response.json({ error: 'method_not_allowed' }, { status: 405, headers });
    const parsed = command.parse(await body(request));
    switch (parsed.action) {
      case 'bootstrap': {
        const active = await registry.bootstrap(environment.modelText, environment.manifestText, now);
        await bootstrapHistory(db, now);
        return Response.json({ model_version: active.bundle.metadata.version, generation: active.generation }, { headers });
      }
      case 'step': return Response.json(await deriveStep(db, bucket, clock), { headers });
      case 'labels': return Response.json(await registerLabels(db, bucket, parsed, now), { headers });
      case 'train_next': {
        const target = parsed.target_version ?? (await db.prepare('SELECT version FROM target_definitions ORDER BY created_at DESC,version LIMIT 1').first<{ version: string }>())?.version;
        if (!target) return Response.json({ status: 'labels_unavailable' }, { headers });
        const built = await buildDataset(db, bucket, target, now);
        if (built.dataset_id === null) return Response.json(built, { headers });
        return Response.json({ ...await beginTraining(db, built.dataset_id, parsed.code_sha, now), dataset_id: built.dataset_id }, { headers });
      }
      case 'candidate': return Response.json(await finishTraining(db, bucket, parsed, now), { headers });
      case 'training_failed': {
        await db.prepare("UPDATE training_runs SET status='failed',error_code=?,finished_at=? WHERE id=? AND status='running'").bind(parsed.code, now.toISOString(), parsed.run_id).run();
        return Response.json({ status: 'recorded' }, { headers });
      }
      case 'approve': await registry.approve(parsed.version, parsed.actor, now); return Response.json({ status: 'approved' }, { headers });
      case 'activate': await registry.activate(parsed.version, parsed.expected_generation, parsed.actor, parsed.reason, now); return Response.json({ status: 'activated', generation: parsed.expected_generation + 1 }, { headers });
      default: return unreachable(parsed);
    }
  } catch (error) {
    if (error instanceof PipelineError) return Response.json({ error: error.code }, { status: error.code === 'request_too_large' ? 413 : 409, headers });
    if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof TypeError && error.message.includes('encoded data')) return Response.json({ error: 'invalid_command_or_artifact' }, { status: 400, headers });
    if (error instanceof ArtifactError) return Response.json({ error: error.code }, { status: 409, headers });
    throw error;
  }
}
function unreachable(value: never): never { throw new PipelineError(`unknown_command_${String(value)}`); }
