import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { authorizedCollection } from '../../../server/cloud/auth';
import { BindingUnavailable } from '../../../server/cloud/bindings';
import { CloudContextStore, ContextStoreError } from '../../../server/context-store';
import { CONTEXT_SOURCE_IDS, ContextRefreshError, downloadContextSource, probeContextConnectivity } from '../../../server/context-refresh';
import { invalidateContextCache } from '../../../server/context-service';
import { ContextMirrorError, downloadPinnedContextMirror } from '../../../server/context-mirror';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };
const command = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start') }).strict(),
  z.object({ action: z.literal('due') }).strict(),
  z.object({ action: z.literal('probe') }).strict(),
  z.object({ action: z.literal('step'), job_id: z.string().min(1).max(100) }).strict(),
  z.object({ action: z.literal('mirror_step'), job_id: z.string().min(1).max(100), expected_manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
]);
function store(): CloudContextStore {
  if (!env.DB || !env.BUCKET) throw new BindingUnavailable();
  return new CloudContextStore(env.DB, env.BUCKET);
}
function failure(error: unknown): Response {
  if (error instanceof ContextStoreError) return Response.json({ error: error.code }, { status: 409, headers });
  if (error instanceof ContextRefreshError) return Response.json({ error: error.code }, { status: 502, headers });
  if (error instanceof ContextMirrorError) return Response.json({ error: error.code }, { status: 502, headers });
  if (error instanceof BindingUnavailable) return Response.json({ error: error.code }, { status: 503, headers });
  if (error instanceof SyntaxError) return Response.json({ error: 'invalid_json' }, { status: 400, headers });
  throw error;
}
export async function GET(request: Request): Promise<Response> {
  if (!await authorizedCollection(request, env.SAFENIGHT_COLLECT_AUTH_TOKEN)) return Response.json({ error: 'unauthorized' }, { status: 401, headers });
  try {
    const jobId = new URL(request.url).searchParams.get('job_id');
    if (jobId) {
      const job = await store().get(jobId);
      const pinned = await store().db.prepare("SELECT sha256 FROM context_raw_documents WHERE job_id=? AND role='mirror_manifest' LIMIT 1").bind(jobId).first<{ sha256: string }>();
      return Response.json(job ? { ...job, mirror_manifest_sha256: pinned?.sha256 ?? null } : { error: 'context_job_not_found' }, { status: job ? 200 : 404, headers });
    }
    return Response.json({ ...await store().overview(), protocol: {
      writer: '/api/internal/context', actions: ['start', 'due', 'step', 'mirror_step', 'probe'], sources: CONTEXT_SOURCE_IDS,
      clock: 'Asia/Seoul', frequency: 'daily', step_limit: 'one_public_source', publish_rule: 'all_four_sources_valid', instructions: '/CONTEXT_OPERATIONS.md',
    } }, { headers });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request): Promise<Response> {
  if (!await authorizedCollection(request, env.SAFENIGHT_COLLECT_AUTH_TOKEN)) return Response.json({ error: 'unauthorized' }, { status: 401, headers });
  if (Number(request.headers.get('Content-Length')) > 8192) return Response.json({ error: 'request_too_large' }, { status: 413, headers });
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > 8192) return Response.json({ error: 'request_too_large' }, { status: 413, headers });
    const parsed = command.safeParse(JSON.parse(text));
    if (!parsed.success) return Response.json({ error: 'invalid_context_command' }, { status: 400, headers });
    const repository = store();
    switch (parsed.data.action) {
      case 'probe': return Response.json({ checked_at: new Date().toISOString(), checks: await probeContextConnectivity() }, { headers });
      case 'start':
      case 'due': return Response.json(await repository.start(new Date()), { headers });
      case 'step':
      case 'mirror_step': {
        const jobId = parsed.data.job_id;
        const previous = await repository.get(jobId);
        if (!previous) return Response.json({ error: 'context_job_not_found' }, { status: 404, headers });
        if (previous.status !== 'running') return Response.json(previous, { headers });
        const token = await repository.claim(jobId, new Date());
        if (!token) return Response.json({ error: 'context_job_busy' }, { status: 409, headers });
        try {
          const job = await repository.get(jobId);
          if (!job) return Response.json({ error: 'context_job_not_found' }, { status: 404, headers });
          const source = CONTEXT_SOURCE_IDS[job.next_source_index];
          if (!source) {
            const completed = await repository.publish(jobId, new Date(), token);
            invalidateContextCache();
            return Response.json(completed, { headers });
          }
          const dataset = parsed.data.action === 'mirror_step' ? await downloadPinnedContextMirror(repository, jobId, source, new Date(), token, undefined, parsed.data.expected_manifest_sha256) : await downloadContextSource(source, new Date(), {
            archive: document => repository.archive(jobId, document, new Date(), token),
          });
          const staged = await repository.stage(jobId, source, dataset, new Date(), token);
          const result = staged.next_source_index === CONTEXT_SOURCE_IDS.length ? await repository.publish(jobId, new Date(), token) : staged;
          if (result.status === 'succeeded') invalidateContextCache();
          return Response.json(result, { headers });
        } catch (error) {
          if (error instanceof ContextRefreshError || error instanceof ContextMirrorError) await repository.fail(jobId, error.code, new Date(), token);
          throw error;
        } finally { await repository.release(jobId, token, new Date()); }
      }
    }
  } catch (error) { return failure(error); }
}
