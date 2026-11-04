import { z } from 'zod';
import type { Assessment, Feature, Status } from '../forest.ts';
import type { LocationAssessment } from '../location-assessment.ts';
import { PipelineError, putJson } from './objects.ts';

const storedSchema = z.object({ id: z.string(), feature_snapshot_id: z.string(), score: z.number().nullable(),
  reason_code: z.enum(['MODEL_UNAVAILABLE', 'DATA_UNAVAILABLE', 'UNSUPPORTED', 'SCHEMA_MISMATCH', 'STALE', 'MODEL_ERROR', 'SCORED']) });
export type StoredAssessment = Assessment & { readonly prediction_id: string | null };

/** Use cached model output only for the exact immutable inputs, model and policy. */
export async function cachedAssessments(db: D1Database, features: readonly Feature[], modelVersion: string, now: Date): Promise<readonly StoredAssessment[]> {
  const records = new Map<string, z.infer<typeof storedSchema>>();
  for (let start = 0; start < features.length; start += 90) {
    const ids = features.slice(start, start + 90).map(feature => feature.feature_revision);
    const rows = z.array(storedSchema).parse((await db.prepare(`SELECT id,feature_snapshot_id,score,reason_code FROM prediction_results
      WHERE model_version=? AND policy_version='rf-environment-support-v1' AND feature_snapshot_id IN (${ids.map(() => '?').join(',')})`).bind(modelVersion, ...ids).all()).results);
    for (const row of rows) records.set(row.feature_snapshot_id, row);
  }
  return features.map(feature => {
    const stored = records.get(feature.feature_revision);
    let status: Status = stored?.reason_code ?? 'DATA_UNAVAILABLE';
    if (!Number.isFinite(now.getTime()) || Date.parse(feature.observed_at) > now.getTime()) status = 'UNSUPPORTED';
    else if (feature.feature_version !== 'environment-v1') status = 'SCHEMA_MISMATCH';
    else if (now.getTime() - Date.parse(feature.observed_at) > 30 * 3600000) status = 'STALE';
    else if (feature.lux === null || feature.noise_db === null || feature.lat === null || feature.lon === null) status = 'DATA_UNAVAILABLE';
    return { score: status === 'SCORED' ? stored?.score ?? null : null, status, observed_at: feature.observed_at,
      assessed_at: Number.isFinite(now.getTime()) ? now.toISOString() : null, model_version: modelVersion,
      feature_version: feature.feature_version, feature_revision: feature.feature_revision,
      policy_version: 'rf-environment-support-v1', prediction_id: stored?.id ?? null };
  });
}

/** Record the actual contributing predictions, so a past interpolation can be rebuilt. */
export async function persistPoint(db: D1Database, bucket: R2Bucket, result: LocationAssessment,
  contributors: readonly { readonly sensor_id: string; readonly prediction_id?: string | null }[], contextSnapshotId: string | null, now: Date): Promise<string> {
  const ids = result.sensors.map(sensor => {
    const predictionId = contributors.find(row => row.sensor_id === sensor.sensor_id)?.prediction_id;
    if (!predictionId) throw new PipelineError('point_prediction_missing');
    return { ...sensor, prediction_id: predictionId };
  });
  const release = await putJson(bucket, 'pipeline/releases', { format: 'safenight-point-release-v1', available_cutoff: now.toISOString(),
    prediction_ids: ids.map(row => row.prediction_id), context_snapshot_id: contextSnapshotId, policy_version: result.method });
  const id = crypto.randomUUID();
  await db.batch([
    db.prepare('INSERT INTO data_releases VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING').bind(release.sha256, release.object_key, release.sha256, now.toISOString(), now.toISOString()),
    db.prepare(`INSERT INTO point_assessments(id,lat,lon,as_of,data_release_id,policy_version,score,status,reason_code,computed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(id, result.location.lat, result.location.lon, result.assessed_at, release.sha256, result.method, result.score, result.score === null ? 'unsupported' : 'scored', result.status, now.toISOString()),
    ...ids.map(row => db.prepare('INSERT INTO point_contributors VALUES(?,?,?,?)').bind(id, row.prediction_id, row.distance_m, row.weight)),
  ]);
  return id;
}
