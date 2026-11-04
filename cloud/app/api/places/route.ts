import { env } from 'cloudflare:workers';
import { PlaceSearchError, PlaceSearchService } from '../../server/place-search';

export const dynamic = 'force-dynamic';
const service = new PlaceSearchService();
const headers = { 'Cache-Control': 'private, no-store' };

/** Called only on an explicit search submission, never on each key stroke. */
export async function GET(request: Request): Promise<Response> {
  try {
    return Response.json(await service.search(new URL(request.url).searchParams.get('q'), env.SAFENIGHT_PLACE_SEARCH_URL), { headers });
  } catch (error) {
    if (!(error instanceof PlaceSearchError)) throw error;
    switch (error.code) {
      case 'invalid_search_query': return Response.json({ error: error.code }, { status: 400, headers });
      case 'place_search_rate_limited': return Response.json({ error: error.code }, { status: 429, headers: { ...headers, 'Retry-After': '2' } });
      case 'place_provider_busy': return Response.json({ error: error.code }, { status: 503, headers: { ...headers, 'Retry-After': '10' } });
      case 'invalid_place_search_configuration': return Response.json({ error: error.code }, { status: 503, headers });
      case 'place_provider_unavailable': case 'invalid_place_response': return Response.json({ error: error.code }, { status: 502, headers });
      default: return unreachable(error.code);
    }
  }
}

function unreachable(value: never): never { throw new TypeError(`Unexpected place search error: ${String(value)}`); }
