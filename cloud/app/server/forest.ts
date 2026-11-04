import { z } from "zod";

const finite = z.number().finite();
const locationSchema = z.object({
  sensor_id: z.string().min(1), lat: finite.min(33).max(39), lon: finite.min(124).max(132),
}).strict().readonly();
const boundsSchema = z.object({
  lux_min: finite, lux_max: finite, noise_min: finite, noise_max: finite,
}).strict().readonly();
const nodeSchema = z.object({
  feature: z.number().int(), threshold: finite, left: z.number().int(), right: z.number().int(),
  value: finite.min(0).max(100),
}).strict().readonly();
const payloadSchema = z.object({
  format: z.literal("safenight-rf-json-v1"), feature_version: z.literal("environment-v1"),
  features: z.tuple([z.literal("lux"), z.literal("noise_db")]).readonly(),
  bounds: boundsSchema, trees: z.array(z.array(nodeSchema).min(1).max(10000).readonly()).min(1).max(256).readonly(),
  locations: z.array(locationSchema).min(1).readonly(),
}).strict().readonly();
const manifestSchema = z.object({
  name: z.literal("RandomForestRegressor"), version: z.string().min(1), experimental: z.literal(true),
  target: z.literal("safety_index"), target_source: z.string(),
  features: z.tuple([z.literal("lux"), z.literal("noise_db")]).readonly(),
  training_rows: z.number().int().positive(), training_sensors: z.number().int().positive(),
  training_sha256: z.string(), artifact_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  validation_mae: finite, validation_r2: finite, validation_note: z.string(),
  train_groups: z.array(z.string()).readonly(), test_groups: z.array(z.string()).readonly(),
  evaluation_train_rows: z.number().int().positive(), evaluation_test_rows: z.number().int().positive(),
  random_state: z.literal(42), trees: z.literal(114), max_depth: z.literal(18), min_samples_leaf: z.literal(3),
  bounds: boundsSchema, training_locations: z.array(locationSchema).min(1).readonly(),
  source_observations_sha256: z.string(), source_predictions_sha256: z.string(),
}).strict().readonly();

export const featureSchema = z.object({
  sensor_id: z.string().min(1), observed_at: z.iso.datetime({ offset: true }),
  lat: finite.min(-90).max(90).nullable(), lon: finite.min(-180).max(180).nullable(),
  lux: finite.nonnegative().nullable(), noise_db: finite.min(0).max(200).nullable(),
  feature_version: z.string().min(1).default("environment-v1"), feature_revision: z.string().min(1),
}).readonly();
export type Feature = z.infer<typeof featureSchema>;
export type Forest = z.infer<typeof payloadSchema>;
export type Manifest = z.infer<typeof manifestSchema>;
export type Bundle = { readonly payload: Forest; readonly metadata: Manifest };
export type Status = "MODEL_UNAVAILABLE" | "DATA_UNAVAILABLE" | "UNSUPPORTED" | "SCHEMA_MISMATCH" | "STALE" | "MODEL_ERROR" | "SCORED";
export type Assessment = {
  readonly score: number | null; readonly status: Status; readonly observed_at: string | null;
  readonly assessed_at: string | null; readonly model_version: string | null; readonly feature_version: string | null;
  readonly feature_revision: string | null; readonly policy_version: "rf-environment-support-v1";
};
type ArtifactCode = "artifact_size_exceeded" | "artifact_digest_mismatch" | "inverted_bounds" | "duplicate_training_sensor" | "invalid_tree_feature" | "invalid_tree_reference" | "manifest_support_mismatch" | "manifest_count_mismatch" | "validation_group_overlap";
export class ArtifactError extends Error {
  readonly code: ArtifactCode;
  constructor(code: ArtifactCode) { super(code); this.name = "ArtifactError"; this.code = code; }
}

/** Parse data-only artifacts and verify the exact bytes before enabling inference. */
export async function loadBundle(modelText: string, manifestText: string, options: { readonly allowGroupOverlap?: boolean } = {}): Promise<Bundle> {
  const bytes = new TextEncoder().encode(modelText);
  if (bytes.length > 32 * 1024 * 1024) throw new ArtifactError("artifact_size_exceeded");
  const metadata = manifestSchema.parse(JSON.parse(manifestText));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const digest = Array.from(hash, value => value.toString(16).padStart(2, "0")).join("");
  if (digest !== metadata.artifact_sha256 || metadata.version !== `rf-environment-v1-${digest.slice(0, 12)}`) throw new ArtifactError("artifact_digest_mismatch");
  const payload = payloadSchema.parse(JSON.parse(modelText));
  if (payload.bounds.lux_min > payload.bounds.lux_max || payload.bounds.noise_min > payload.bounds.noise_max) throw new ArtifactError("inverted_bounds");
  if (new Set(payload.locations.map(point => point.sensor_id)).size !== payload.locations.length) throw new ArtifactError("duplicate_training_sensor");
  for (const tree of payload.trees) {
    for (const [index, node] of tree.entries()) {
      if (node.left === -1 && node.right === -1) continue;
      if (node.feature !== 0 && node.feature !== 1) throw new ArtifactError("invalid_tree_feature");
      if (!(index < node.left && node.left < tree.length && index < node.right && node.right < tree.length)) throw new ArtifactError("invalid_tree_reference");
    }
  }
  if (JSON.stringify(payload.locations) !== JSON.stringify(metadata.training_locations) || JSON.stringify(payload.bounds) !== JSON.stringify(metadata.bounds)) throw new ArtifactError("manifest_support_mismatch");
  if (payload.trees.length !== metadata.trees || payload.locations.length !== metadata.training_sensors) throw new ArtifactError("manifest_count_mismatch");
  const testing = new Set(metadata.test_groups);
  if (!options.allowGroupOverlap && metadata.train_groups.some(id => testing.has(id))) throw new ArtifactError("validation_group_overlap");
  return { payload, metadata };
}

/** Haversine geometry matches the existing Python model's 250m support test. */
export function distanceMeters(lat: number, lon: number, otherLat: number, otherLon: number): number {
  const radians = (value: number) => value * (Math.PI / 180);
  const term = Math.sin(radians(otherLat - lat) / 2) ** 2 + Math.cos(radians(lat)) * Math.cos(radians(otherLat)) * Math.sin(radians(otherLon - lon) / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.min(1, Math.sqrt(term)));
}

export function supports(bundle: Bundle, feature: Feature): boolean {
  const { lat, lon, lux, noise_db: noise } = feature;
  if (lat === null || lon === null || lux === null || noise === null) return false;
  const bounds = bundle.payload.bounds;
  if (!(Number.isFinite(lux) && Number.isFinite(noise) && bounds.lux_min <= lux && lux <= bounds.lux_max && bounds.noise_min <= noise && noise <= bounds.noise_max)) return false;
  return bundle.payload.locations.some(point => point.sensor_id === feature.sensor_id && distanceMeters(lat, lon, point.lat, point.lon) <= 250);
}

/** Sequential averaging and float32 inputs reproduce sklearn's exported forest. */
export function predict(bundle: Bundle, lux: number, noise: number): number {
  const values = [Math.fround(lux), Math.fround(noise)];
  let sum = 0;
  for (const tree of bundle.payload.trees) {
    let index = 0;
    let node = tree[index];
    while (node && node.left !== -1) {
      index = values[node.feature] <= node.threshold ? node.left : node.right;
      node = tree[index];
    }
    if (!node) throw new ArtifactError("invalid_tree_reference");
    sum += node.value;
  }
  return sum / bundle.payload.trees.length;
}

/** Preserve Python's fail-closed status precedence, including missing-input handling. */
export function assess(bundle: Bundle | null, feature: Feature | null, now: Date): Assessment {
  const assessedAt = Number.isFinite(now.getTime()) ? now.toISOString() : null;
  let status: Status;
  let score: number | null = null;
  if (bundle === null) status = "MODEL_UNAVAILABLE";
  else if (feature === null) status = "DATA_UNAVAILABLE";
  else if (assessedAt === null || Date.parse(feature.observed_at) > now.getTime()) status = "UNSUPPORTED";
  else if (feature.feature_version !== bundle.payload.feature_version) status = "SCHEMA_MISMATCH";
  else if (now.getTime() - Date.parse(feature.observed_at) > 30 * 60 * 60 * 1000) status = "STALE";
  else if (feature.lat === null || feature.lon === null || feature.lux === null || feature.noise_db === null) status = "DATA_UNAVAILABLE";
  else if (!supports(bundle, feature)) status = "UNSUPPORTED";
  else {
    const prediction = predict(bundle, feature.lux, feature.noise_db);
    if (Number.isFinite(prediction) && prediction >= 0 && prediction <= 100) { status = "SCORED"; score = prediction; }
    else status = "MODEL_ERROR";
  }
  return {
    score, status, observed_at: feature?.observed_at ?? null, assessed_at: assessedAt,
    model_version: bundle?.metadata.version ?? null, feature_version: feature?.feature_version ?? null,
    feature_revision: feature?.feature_revision ?? null, policy_version: "rf-environment-support-v1",
  };
}
