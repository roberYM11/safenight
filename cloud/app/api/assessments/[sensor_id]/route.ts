import { assessSensor } from "../../../server/serving";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { readonly params: Promise<{ readonly sensor_id: string }> }) {
  const { sensor_id: sensorId } = await context.params;
  return Response.json(await assessSensor(sensorId), { headers: { "Cache-Control": "no-store" } });
}
