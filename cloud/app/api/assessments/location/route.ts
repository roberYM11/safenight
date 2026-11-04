import { LocationQueryError, parseLocationQuery } from '../../../server/location-assessment';
import { assessPoint } from '../../../server/serving';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const point = parseLocationQuery(new URL(request.url).searchParams);
    const now = new Date();
    return Response.json(await assessPoint(point, now), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof LocationQueryError) return Response.json({ error: error.code }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
    throw error;
  }
}
