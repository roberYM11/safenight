import { z } from 'zod';
import { canonicalJson } from '../cloud/contracts.ts';
import { loadBundle } from '../forest.ts';
import { readDataset } from './datasets.ts';
import { evaluateCandidate } from './evaluation.ts';
import type { Candidate } from './evaluation.ts';
import { ModelRegistry } from './models.ts';
import { PipelineError, putJson, readBytes } from './objects.ts';

export async function finishTraining(db: D1Database, bucket: R2Bucket, candidate: Candidate, now: Date) {
  const run = await db.prepare('SELECT * FROM training_runs WHERE id=?').bind(candidate.run_id).first<{ dataset_id: string; status: string; target_version: string; code_sha: string }>();
  if (!run) throw new PipelineError('training_run_missing');
  const bundle = await loadBundle(candidate.model_text, candidate.manifest_text);
  const dataset = await readDataset(db, bucket, run.dataset_id);
  if (bundle.metadata.training_sha256 !== run.dataset_id || bundle.metadata.training_rows !== dataset.rows.length || bundle.payload.feature_version !== dataset.feature_version) throw new PipelineError('training_dataset_mismatch');
  const locations = [...new Map(dataset.rows.map(row => [row.feature.sensor_id, { sensor_id: row.feature.sensor_id, lat: row.feature.lat, lon: row.feature.lon }])).values()].sort((a, b) => a.sensor_id < b.sensor_id ? -1 : a.sensor_id > b.sensor_id ? 1 : 0);
  if (canonicalJson(bundle.payload.locations) !== canonicalJson(locations)) throw new PipelineError('training_location_mismatch');
  if (run.status === 'succeeded') {
    const recorded = await db.prepare('SELECT metrics_json FROM training_runs WHERE id=?').bind(candidate.run_id).first<{ metrics_json: string }>();
    if (!recorded || z.object({ model_version: z.string() }).parse(JSON.parse(recorded.metrics_json)).model_version !== bundle.metadata.version) throw new PipelineError('training_result_mismatch');
    return { status: 'already_recorded', model_version: bundle.metadata.version };
  }
  if (run.status !== 'running') throw new PipelineError('training_run_not_running');
  const active = await new ModelRegistry(db, bucket).active();
  if (!active) throw new PipelineError('active_model_missing');
  const report = await evaluateCandidate(candidate, dataset, active.bundle, bundle);
  const evidence = await putJson(bucket, 'pipeline/evaluations', { dataset_id: run.dataset_id, code_sha: run.code_sha, candidate, report });
  const key = `models/${bundle.metadata.artifact_sha256}.json`;
  if (!await bucket.head(key)) await bucket.put(key, new TextEncoder().encode(candidate.model_text));
  await readBytes(bucket, key, bundle.metadata.artifact_sha256);
  const stamp = now.toISOString();
  const guard = `training:${crypto.randomUUID()}`;
  await db.batch([
    db.prepare("INSERT INTO operation_guards(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM training_runs WHERE id=? AND status='running') THEN 1 ELSE 0 END").bind(guard, candidate.run_id),
    db.prepare(`INSERT INTO model_artifacts(version,training_run_id,origin,feature_version,target_version,object_key,digest,manifest_json,created_at)
      VALUES(?,?,'trained','environment-v1',?,?,?,?,?) ON CONFLICT DO NOTHING`).bind(bundle.metadata.version, candidate.run_id, run.target_version, key, bundle.metadata.artifact_sha256, candidate.manifest_text, stamp),
    db.prepare("UPDATE training_runs SET status='succeeded',metrics_json=?,baseline_metrics_json=?,finished_at=? WHERE id=?")
      .bind(canonicalJson({ ...report, model_version: bundle.metadata.version, evidence }), canonicalJson(report.evaluations.map(row => ({ kind: row.kind, mean: row.mean, median: row.median }))), stamp, candidate.run_id),
    db.prepare('DELETE FROM operation_guards WHERE id=?').bind(guard),
  ]);
  return { status: 'candidate', model_version: bundle.metadata.version, report };
}
