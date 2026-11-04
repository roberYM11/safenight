import { buildMap } from "../../server/serving";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await buildMap(), { headers: { "Cache-Control": "no-store" } });
}
