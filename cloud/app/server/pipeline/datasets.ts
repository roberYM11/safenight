import { z } from 'zod';
import { featureSchema } from '../forest.ts';
import { canonicalJson, sha256 } from '../cloud/contracts.ts';
import { PipelineError, putJson, readJson } from './objects.ts';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const labelRequestSchema = z.object({
  definition: z.object({ kind: z.literal('rule_index'), description: z.string().min(1).max(2000), rule_version: z.string().min(1).max(100).default('externally-supplied-v1'), source_name: z.string().min(1).max(200), source_sha256: digest }).strict(),
  rows: z.array(z.object({ feature_snapshot_id: digest, value: z.number().finite().min(0).max(100), target_time: z.iso.datetime({ precision: 3 }) }).strict()).min(1).max(200),
}).strict();
export type LabelRequest = z.infer<typeof labelRequestSchema>;
export const datasetRowSchema = z.object({
  feature_snapshot_id: digest, data_release_id: digest, feature: featureSchema,
  feature_available_at: z.iso.datetime(), target_id: digest, target_value: z.number().finite().min(0).max(100),
  target_time: z.iso.datetime(), target_available_at: z.iso.datetime(), target_object_key: z.string(), target_sha256: digest,
}).readonly();
export const datasetSchema = z.object({
  format: z.literal('safenight-training-v1'), feature_version: z.literal('environment-v1'), target_version: z.string(),
  training_cutoff: z.iso.datetime(), split_policy: z.literal('sensor-time-region-v1'), rows: z.array(datasetRowSchema).min(1).max(10000),
}).readonly();
export type FrozenDataset = z.infer<typeof datasetSchema>;

/** Labels are externally supplied evidence. Import time is system availability, never backdated. */
export async function registerLabels(db: D1Database, bucket: R2Bucket, request: LabelRequest, now: Date) {
  if (new Set(request.rows.map(row => row.feature_snapshot_id)).size !== request.rows.length) throw new PipelineError('duplicate_target_feature');
  const definition = await putJson(bucket, 'pipeline/targets/definitions', {
    kind: request.definition.kind, description: request.definition.description,
    rule_version: request.definition.rule_version, source_name: request.definition.source_name,
  });
  const version = `rule-index-${definition.sha256}`;
  const statements: D1PreparedStatement[] = [db.prepare(`INSERT INTO target_definitions(version,kind,description,definition_object_key,definition_sha256,horizon_seconds,created_at)
    VALUES(?,'rule_index',?,?,?,NULL,?) ON CONFLICT DO NOTHING`).bind(version, request.definition.description, definition.object_key, definition.sha256, now.toISOString())];
  const features = new Map<string, string>();
  const existing = new Map<string, { readonly value: number; readonly target_time: string }>();
  for (let offset = 0; offset < request.rows.length; offset += 90) {
    const ids = request.rows.slice(offset, offset + 90).map(row => row.feature_snapshot_id);
    const placeholders = ids.map(() => '?').join(',');
    const selected = z.array(z.object({ id: z.string(), as_of: z.string() })).parse((await db.prepare(`SELECT id,as_of FROM feature_snapshots WHERE id IN (${placeholders})`).bind(...ids).all()).results);
    for (const row of selected) features.set(row.id, row.as_of);
    const labels = z.array(z.object({ feature_snapshot_id: z.string(), value: z.number(), target_time: z.string() })).parse((await db.prepare(`SELECT feature_snapshot_id,value,target_time FROM target_values WHERE target_version=? AND feature_snapshot_id IN (${placeholders})`).bind(version, ...ids).all()).results);
    for (const row of labels) existing.set(row.feature_snapshot_id, row);
  }
  const object = await putJson(bucket, 'pipeline/targets/labels', request);
  const values: (string | number)[][] = [];
  for (const row of request.rows) {
    if (features.get(row.feature_snapshot_id) !== row.target_time || row.target_time > now.toISOString()) throw new PipelineError('target_feature_time_mismatch');
    const prior = existing.get(row.feature_snapshot_id);
    if (prior && (prior.value !== row.value || prior.target_time !== row.target_time)) throw new PipelineError('target_revision_requires_new_definition');
    const id = await sha256(new TextEncoder().encode(canonicalJson({ ...row, target_version: version })));
    values.push([id, row.feature_snapshot_id, version, row.value, row.target_time, now.toISOString(), object.object_key, object.sha256]);
  }
  for (let offset = 0; offset < values.length; offset += 12) {
    const chunk = values.slice(offset, offset + 12);
    statements.push(db.prepare(`INSERT INTO target_values(id,feature_snapshot_id,target_version,value,target_time,available_at,object_key,sha256)
      VALUES ${chunk.map(() => '(?,?,?,?,?,?,?,?)').join(',')} ON CONFLICT(id) DO NOTHING`).bind(...chunk.flat()));
  }
  try { await db.batch(statements); }
  catch (error) {
    if (error instanceof Error && error.message.includes('target_values.feature_snapshot_id')) throw new PipelineError('target_revision_requires_new_definition');
    throw error;
  }
  return { target_version: version, imported_rows: request.rows.length };
}

/** Freeze exact feature/label revisions. Latest unlabeled corrections are excluded, not replaced by old labels. */
export async function buildDataset(db: D1Database, bucket: R2Bucket, targetVersion: string, now: Date) {
  const sql = `WITH history AS (
    SELECT s.*,ROW_NUMBER() OVER(PARTITION BY s.source,s.entity_id,s.observed_at ORDER BY p.sequence DESC) selected
    FROM observation_selections s JOIN observation_publications p ON p.sequence=s.publication_sequence WHERE p.available_at<=?
  ), visible AS (SELECT * FROM history WHERE selected=1), ranked AS (
    SELECT f.*,ROW_NUMBER() OVER(PARTITION BY entity_id,as_of ORDER BY available_cutoff DESC,created_at DESC,id DESC) chosen
    FROM feature_snapshots f WHERE available_cutoff<=? AND EXISTS(
      SELECT 1 FROM visible v WHERE v.source='sdot' AND v.entity_id=f.entity_id AND v.observed_at=f.as_of AND v.revision_id=f.observation_revision_id
    ) AND f.location_revision_id=(SELECT l.revision_id FROM visible l WHERE l.source='sensor_locations' AND l.entity_id=f.entity_id AND l.observed_at<=f.as_of ORDER BY l.observed_at DESC LIMIT 1)
  ) SELECT f.id AS feature_snapshot_id,f.data_release_id,f.payload_json,f.available_cutoff AS feature_available_at,
    t.id AS target_id,t.value AS target_value,t.target_time,t.available_at AS target_available_at,t.object_key AS target_object_key,t.sha256 AS target_sha256
  FROM ranked f JOIN target_values t ON t.feature_snapshot_id=f.id
  WHERE f.chosen=1 AND t.target_version=? AND t.available_at<=? ORDER BY f.entity_id,f.as_of LIMIT 10001`;
  const rows = (await db.prepare(sql).bind(now.toISOString(), now.toISOString(), targetVersion, now.toISOString()).all()).results;
  if (!rows.length) return { status: 'labels_unavailable' as const, dataset_id: null };
  if (rows.length > 10000) throw new PipelineError('dataset_row_limit');
  const parsed = rows.map(row => {
    const input = z.object({ payload_json: z.string() }).parse(row);
    return datasetRowSchema.parse({ ...row, feature: featureSchema.parse(JSON.parse(input.payload_json)) });
  });
  const trainingCutoff = parsed.reduce((latest, row) => [latest, row.feature_available_at, row.target_available_at].sort().at(-1) ?? latest, '');
  const dataset = datasetSchema.parse({ format: 'safenight-training-v1', feature_version: 'environment-v1', target_version: targetVersion, training_cutoff: trainingCutoff, split_policy: 'sensor-time-region-v1', rows: parsed });
  const object = await putJson(bucket, 'pipeline/datasets', dataset);
  const release = await putJson(bucket, 'pipeline/releases', { format: 'safenight-dataset-release-v1', available_cutoff: trainingCutoff,
    feature_ids: parsed.map(row => row.feature_snapshot_id), target_ids: parsed.map(row => row.target_id), source_release_ids: [...new Set(parsed.map(row => row.data_release_id))].sort() });
  await db.batch([
    db.prepare('INSERT INTO data_releases VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING').bind(release.sha256, release.object_key, release.sha256, trainingCutoff, now.toISOString()),
    db.prepare(`INSERT INTO dataset_snapshots(id,data_release_id,object_key,sha256,feature_version,target_version,split_policy_json,row_count,created_at)
      VALUES(?,?,?,?,'environment-v1',?,?,?,?) ON CONFLICT DO NOTHING`).bind(object.sha256, release.sha256, object.object_key, object.sha256, targetVersion, canonicalJson({ version: dataset.split_policy, seed: 42, training_cutoff: trainingCutoff }), parsed.length, now.toISOString()),
  ]);
  return { status: 'ready' as const, dataset_id: object.sha256 };
}

export async function readDataset(db: D1Database, bucket: R2Bucket, id: string): Promise<FrozenDataset> {
  const row = await db.prepare('SELECT object_key,sha256 FROM dataset_snapshots WHERE id=?').bind(id).first<{ object_key: string; sha256: string }>();
  if (!row) throw new PipelineError('dataset_missing');
  return datasetSchema.parse(await readJson(bucket, row.object_key, row.sha256));
}

export async function beginTraining(db: D1Database, datasetId: string, codeSha: string, now: Date) {
  const dataset = await db.prepare('SELECT feature_version,target_version FROM dataset_snapshots WHERE id=?').bind(datasetId).first<{ feature_version: string; target_version: string }>();
  if (!dataset) throw new PipelineError('dataset_missing');
  await db.prepare("UPDATE training_runs SET status='failed',error_code='worker_timeout',finished_at=? WHERE dataset_id=? AND status='running' AND started_at<?")
    .bind(now.toISOString(), datasetId, new Date(now.getTime() - 2 * 3600000).toISOString()).run();
  const existing = await db.prepare("SELECT id,status FROM training_runs WHERE dataset_id=? AND (status='running' OR (status='succeeded' AND code_sha=?)) ORDER BY started_at DESC LIMIT 1").bind(datasetId, codeSha).first<{ id: string; status: string }>();
  if (existing) return { status: existing.status === 'succeeded' ? 'unchanged' : 'busy', run_id: existing.id };
  const id = crypto.randomUUID();
  try {
    await db.prepare(`INSERT INTO training_runs(id,dataset_id,feature_version,target_version,code_sha,seed,status,parameters_json,evaluation_policy_version,started_at)
      VALUES(?,?,?,?,?,42,'running',?,'sensor-time-region-v1',?)`)
      .bind(id, datasetId, dataset.feature_version, dataset.target_version, codeSha, canonicalJson({ trees: 114, max_depth: 18, min_samples_leaf: 3 }), now.toISOString()).run();
  } catch (error) {
    if (error instanceof Error && error.message.includes('training_runs.dataset_id')) return { status: 'busy', run_id: null };
    throw error;
  }
  return { status: 'running', run_id: id };
}
