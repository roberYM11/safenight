import { env } from 'cloudflare:workers';
import { populationPointSchema, PopulationService } from '../../server/population';
import { CloudPopulationStore } from '../../server/population-store';

export const dynamic = 'force-dynamic';
let service: PopulationService | undefined;
const headers = { 'Cache-Control': 'private, no-store' };

/** Area aggregates preserve containment or an explicitly labelled boundary-distance relationship. */
export async function GET(request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const point = populationPointSchema.safeParse({ lat: query.get('lat'), lon: query.get('lon') });
  if (!point.success) return Response.json({ error: 'invalid_population_coordinates' }, { status: 400, headers });
  if (!env.DB || !env.BUCKET) return Response.json({ error: 'population_storage_unavailable' }, { status: 503, headers });
  service ??= new PopulationService({ store: new CloudPopulationStore(env.DB, env.BUCKET) });
  return Response.json(await service.at(point.data, env.SAFENIGHT_SDOT_API_KEY ?? ''), { headers });
}
