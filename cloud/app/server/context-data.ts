import { z } from "zod";
import snapshot from "./data/context-facilities.json" with { type: "json" };
import { distanceMeters } from "./forest.ts";

const kindSchema = z.enum(["streetlight", "security_light", "cctv"]);
const sourceSchema = z.object({
  id: z.string().min(1), title: z.string().min(1), url: z.url(), download_url: z.url(),
  license: z.string().min(1), license_url: z.url(), updated_at: z.iso.date(), reference_date: z.iso.date(),
  retrieved_at: z.iso.datetime(), district: z.string().min(1), coverage_note: z.string().min(1),
  raw_sha256: z.string().regex(/^[a-f0-9]{64}$/), source_rows: z.number().int().positive(),
  accepted_rows: z.number().int().positive(), rejected_rows: z.number().int().nonnegative(),
  reference_date_end: z.iso.date().optional(),
}).strict().readonly();
const rowSchema = z.tuple([
  z.string().min(1), kindSchema, z.string().min(1), z.string().min(1),
  z.number().finite().min(37.4).max(37.72), z.number().finite().min(126.7).max(127.2),
  z.string().min(1).nullable(), z.number().int().min(1).max(1000).optional(), z.iso.date().optional(),
]).readonly();
const datasetSchema = z.object({
  format: z.literal("safenight-context-v1"), sources: z.array(sourceSchema).min(1).readonly(),
  facilities: z.array(rowSchema).min(1).max(50000).readonly(),
}).strict().readonly().superRefine((dataset, ctx) => {
  const sources = new Map(dataset.sources.map(source => [source.id, source]));
  const ids = new Set<string>(); const counts = new Map<string, number>();
  for (const row of dataset.facilities) {
    if (!sources.has(row[0]) || ids.has(row[2])) ctx.addIssue({ code: "custom", message: "Unknown source or duplicate facility identifier" });
    if (row[1] === "cctv" && (row[7] === undefined || row[8] === undefined)) ctx.addIssue({ code: "custom", message: "CCTV requires source camera count and reference date" });
    if (row[1] !== "cctv" && row[7] !== undefined) ctx.addIssue({ code: "custom", message: "Camera count only applies to CCTV" });
    ids.add(row[2]); counts.set(row[0], (counts.get(row[0]) ?? 0) + 1);
  }
  for (const source of dataset.sources) {
    if (counts.get(source.id) !== source.accepted_rows || source.accepted_rows + source.rejected_rows !== source.source_rows) {
      ctx.addIssue({ code: "custom", message: "Source row counts do not match the snapshot" });
    }
  }
});

export type ContextSource = z.infer<typeof sourceSchema>;
export type ContextKind = z.infer<typeof kindSchema>;
export type ContextDataset = z.infer<typeof datasetSchema>;
export type NearbyContextFacility = Readonly<{
  id: string; kind: ContextKind; name: string; lat: number; lon: number;
  address: string | null; phone: null; source_id: string; distance_m: number;
  camera_count: number | null; reference_date: string | null;
}>;
export type ContextGroup = Readonly<{
  kind: ContextKind; label: string; status: "AVAILABLE" | "NO_RECORDS";
  count: number | null; unit: "개" | "대"; record_count: number | null; nearest: readonly NearbyContextFacility[];
}>;
export type ContextSummary = Readonly<{
  radius_m: number; usage: "CONTEXT_ONLY"; score_included: false;
  groups: readonly ContextGroup[]; sources: readonly ContextSource[];
}>;

export function parseContextDataset(value: unknown): ContextDataset {
  return datasetSchema.parse(value);
}

const bundledDataset = parseContextDataset(snapshot);
export function getBundledContextDataset(): ContextDataset { return bundledDataset; }
const querySchema = z.object({ lat: z.number().finite().min(-90).max(90), lon: z.number().finite().min(-180).max(180) }).strict();
const radiusSchema = z.number().finite().min(1).max(5000);

/** Counts published installation records, never current illumination or a safety score. */
export function summarizeContext(
  point: Readonly<{ lat: number; lon: number }>, radiusM = 1000, dataset: ContextDataset = bundledDataset,
): ContextSummary {
  const location = querySchema.parse(point); const radius = radiusSchema.parse(radiusM);
  const angularRadius = radius / 6371000;
  const latitudeDelta = angularRadius * 180 / Math.PI;
  const longitudeDelta = Math.abs(location.lat) + latitudeDelta >= 90
    ? 180 : Math.asin(Math.min(1, Math.sin(angularRadius) / Math.cos(location.lat * Math.PI / 180))) * 180 / Math.PI;
  const matches = dataset.facilities.flatMap(([source_id, kind, id, name, lat, lon, address, cameraCount, referenceDate]) => {
    const longitudeDifference = Math.abs(lon - location.lon);
    if (Math.abs(lat - location.lat) > latitudeDelta + 1e-9 || Math.min(longitudeDifference, 360 - longitudeDifference) > longitudeDelta + 1e-9) return [];
    const distance = distanceMeters(location.lat, location.lon, lat, lon);
    if (distance > radius) return [];
    return [{ id, kind, name, lat, lon, address, phone: null, source_id, distance_m: distance, camera_count: cameraCount ?? null, reference_date: referenceDate ?? null }];
  }).sort((left, right) => left.distance_m - right.distance_m || left.id.localeCompare(right.id));
  const kinds: readonly ContextKind[] = ["streetlight", "security_light", "cctv"];
  const labels: Readonly<Record<ContextKind, string>> = { streetlight: "가로등", security_light: "보안등", cctv: "CCTV" };
  const groups = kinds.map((kind): ContextGroup => {
    const rows = matches.filter(row => row.kind === kind);
    return {
      kind, label: labels[kind], status: rows.length ? "AVAILABLE" : "NO_RECORDS",
      count: rows.length ? (kind === "cctv" ? rows.reduce((sum, row) => sum + (row.camera_count ?? 0), 0) : rows.length) : null,
      unit: kind === "cctv" ? "대" : "개", record_count: rows.length || null,
      nearest: rows.slice(0, 3).map(row => ({ ...row, distance_m: Math.round(row.distance_m) })),
    };
  });
  return { radius_m: radius, usage: "CONTEXT_ONLY", score_included: false, groups, sources: dataset.sources };
}
