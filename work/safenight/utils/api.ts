import ky from "ky";
import { z } from "zod";

const timestamp = z.iso.datetime({ offset: true });
const SensorSchema = z.object({
  sensor_id: z.string().min(1).brand<"SensorId">(),
  lat: z.number().finite().min(-90).max(90),
  lon: z.number().finite().min(-180).max(180),
  district: z.string(),
  neighborhood: z.string(),
  observed_at: timestamp,
  lux: z.number().finite().nonnegative().nullable(),
  noise_db: z.number().finite().nonnegative().nullable(),
  score: z.number().finite().min(0).max(100).nullable(),
  status: z.string(),
  feature_revision: z.string(),
}).readonly();

const MapSchema = z.object({
  generated_at: timestamp,
  sensors: z.array(SensorSchema).readonly(),
}).readonly();

export type Sensor = z.infer<typeof SensorSchema>;
export type MapData = z.infer<typeof MapSchema>;
export type Dashboard = { readonly map: MapData };

const client = ky.create({ timeout: 20000, retry: 0 });

export async function loadDashboard(signal: AbortSignal): Promise<Dashboard> {
  const map = await client.get("/api/map", { signal }).json<unknown>();
  return { map: MapSchema.parse(map) };
}
