import ky from "ky";
import { z } from "zod";

const coordinate = z.number().finite();
const timestamp = z.iso.datetime({ offset: true });
const placeSchema = z.object({
  id: z.string(), name: z.string(), address: z.string(),
  lat: coordinate.min(-90).max(90), lon: coordinate.min(-180).max(180),
  source: z.literal("openstreetmap"), category: z.enum(["station", "place"]),
}).readonly();
const searchSchema = z.object({
  query: z.string(), places: z.array(placeSchema).readonly(), attribution: z.string(),
  attribution_url: z.string().url(), provider: z.string(), provider_url: z.string().url(),
}).readonly();
const assessmentSchema = z.object({
  location: z.object({ lat: coordinate, lon: coordinate }).readonly(),
  score: coordinate.min(0).max(100).nullable(), lux: coordinate.nonnegative().nullable(), noise_db: coordinate.nonnegative().nullable(),
  status: z.enum(["SCORED", "NO_NEARBY_OBSERVATIONS", "NO_USABLE_OBSERVATIONS", "OUTSIDE_SERVICE_AREA"]),
  assessed_at: timestamp, observed_from: timestamp.nullable(), observed_until: timestamp.nullable(),
  method: z.literal("inverse-distance-squared-v1"),
  coverage: z.object({ radius_m: coordinate.positive(), sensor_count: z.number().int().min(0).max(8), nearby_sensor_count: z.number().int().nonnegative(), nearest_sensor_m: coordinate.nonnegative().nullable() }).readonly(),
  sensors: z.array(z.object({ sensor_id: z.string(), lat: coordinate, lon: coordinate, observed_at: timestamp, distance_m: coordinate.nonnegative(), weight: coordinate.min(0).max(1), score: coordinate.min(0).max(100), lux: coordinate.nonnegative(), noise_db: coordinate.nonnegative() }).readonly()).readonly(),
}).readonly();

export type Place = z.infer<typeof placeSchema>;
export type PlaceTarget = Pick<Place, "id" | "name" | "address" | "lat" | "lon">;
export type PlaceSearchResult = z.infer<typeof searchSchema>;
export type PlaceAssessment = z.infer<typeof assessmentSchema>;
const client = ky.create({ timeout: 18000, retry: 0 });

export async function searchPlaces(query: string, signal: AbortSignal): Promise<PlaceSearchResult> {
  return searchSchema.parse(await client.get("/api/places", { searchParams: { q: query }, signal }).json<unknown>());
}
export async function loadPlaceAssessment(point: PlaceTarget, signal: AbortSignal): Promise<PlaceAssessment> {
  return assessmentSchema.parse(await client.get("/api/assessments/location", { searchParams: { lat: point.lat, lon: point.lon }, signal }).json<unknown>());
}

export type PlaceAssessmentState = { readonly kind: "idle" } | { readonly kind: "loading" } | { readonly kind: "ready"; readonly data: PlaceAssessment } | { readonly kind: "error" };
