import { locationContext } from "../../server/context-service";
import { LocationQueryError, parseLocationQuery } from "../../server/location-assessment";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const location = parseLocationQuery(new URL(request.url).searchParams);
    return Response.json({ location, ...await locationContext(location) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof LocationQueryError) return Response.json({ error: error.code }, { status: 400 });
    throw error;
  }
}
