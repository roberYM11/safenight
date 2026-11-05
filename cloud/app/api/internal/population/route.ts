import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { authorizedCollection } from '../../../server/cloud/auth';
import { publishedPopulationAreas, PopulationService } from '../../../server/population';
import { CloudPopulationStore } from '../../../server/population-store';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };
const command = z.strictObject({
  cursor: z.int().min(0).max(publishedPopulationAreas.length - 1),
  limit: z.int().min(1).max(3).default(3),
});
const MAX_BYTES = 256;

export async function POST(request: Request): Promise<Response> {
  if (!await authorizedCollection(request, env.SAFENIGHT_COLLECT_AUTH_TOKEN)) return Response.json({ error: 'unauthorized' }, { status: 401, headers });
  const oversized = () => Response.json({ error: 'request_too_large' }, { status: 413, headers });
  if (Number(request.headers.get('Content-Length')) > MAX_BYTES) return oversized();
  const reader = request.body?.getReader();
  const bytes = new Uint8Array(MAX_BYTES);
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (size + chunk.value.byteLength > MAX_BYTES) { await reader.cancel(); return oversized(); }
        bytes.set(chunk.value, size);
        size += chunk.value.byteLength;
      }
    } finally { reader.releaseLock(); }
  }
  let input: unknown;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))); }
  catch { return Response.json({ error: 'invalid_json' }, { status: 400, headers }); }
  const parsed = command.safeParse(input);
  if (!parsed.success) return Response.json({ error: 'invalid_population_command' }, { status: 400, headers });
  if (!env.DB || !env.BUCKET) return Response.json({ error: 'population_storage_unavailable' }, { status: 503, headers });

  const { cursor, limit } = parsed.data;
  const service = new PopulationService({ store: new CloudPopulationStore(env.DB, env.BUCKET) });
  const batch = publishedPopulationAreas.slice(cursor, cursor + limit);
  try {
    const areas = await Promise.all(batch.map(area => service.collect(area, env.SAFENIGHT_SDOT_API_KEY ?? '')));
    const end = cursor + batch.length;
    return Response.json({ areas, total: publishedPopulationAreas.length, next_cursor: end < publishedPopulationAreas.length ? end : null }, { headers });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return Response.json({ error: 'population_collection_unavailable' }, { status: 503, headers });
  }
}
