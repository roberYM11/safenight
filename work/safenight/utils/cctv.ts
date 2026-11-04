import { z } from "zod";

const PublicUrl = z.url().refine(value => new URL(value).protocol === "https:", "HTTPS required");

export const CameraSchema = z.object({
  camera_id: z.string(),
  name: z.string().nullable().optional(),
  distance_m: z.number().nonnegative(),
  video_available: z.boolean(),
  playback_url: PublicUrl.nullable().default(null),
  playback_type: z.enum(["hls", "mp4", "external"]).nullable().default(null),
  source_url: PublicUrl.nullable().default(null),
}).readonly();

export const NearbyCctvSchema = z.object({
  status: z.enum(["FOUND", "NO_MATCH", "COVERAGE_UNKNOWN", "PROVIDER_ERROR"]),
  radius_m: z.number().positive(),
  lookup_scope: z.enum(["stored_facilities", "provider", "mixed"]),
  lookup_complete: z.boolean().default(false),
  cameras: z.array(CameraSchema).readonly(),
  video_status: z.enum(["AVAILABLE", "SOURCE_NOT_CONNECTED", "NO_PLAYABLE_VIDEO", "PROVIDER_ERROR"]),
  message: z.string(),
}).readonly();

export type NearbyCamera = z.infer<typeof CameraSchema>;
export type NearbyCctv = z.infer<typeof NearbyCctvSchema>;
