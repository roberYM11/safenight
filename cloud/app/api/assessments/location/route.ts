import { assessLocation, LocationQueryError, parseLocationQuery } from '../../../server/location-assessment';
import { buildMap } from '../../../server/serving';
import { locationContext } from '../../../server/context-service';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const point = parseLocationQuery(new URL(request.url).searchParams);
    const now = new Date();
    const [map, context] = await Promise.all([buildMap(now), locationContext(point, now)]);
    return Response.json({ ...assessLocation(point, map.sensors, now), score_inputs: ["lux", "noise_db"], context }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof LocationQueryError) return Response.json({ error: error.code }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
    throw error;
  }
}
