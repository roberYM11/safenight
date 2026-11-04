import { z } from 'zod';
import { canonicalJson, sha256 } from '../cloud/contracts.ts';
import { assess, featureSchema } from '../forest.ts';
import type { Bundle, Feature } from '../forest.ts';
import { featureFromInput, inputPage } from './inputs.ts';
import { ModelRegistry } from './models.ts';
import { PipelineError, putJson } from './objects.ts';

const pageSize = 20;
const jobSchema = z.object({ id: z.string(), kind: z.enum(['features', 'rescore']), input_version: z.string(), publication_sequence: z.number().nullable(),
  model_version: z.string().nullable(),
  cursor_entity: z.string(), cursor_time: z.string(), processed_rows: z.number(), created_at: z.string() });

/** Explicit upgrade checkpoint. Legacy visibility begins now, never at a guessed past time. */
export async function bootstrapHistory(db: D1Database, now: Date): Promise<void> {
  if (await db.prepare("SELECT 1 FROM observation_publications WHERE origin='baseline'").first()) return;
  const stamp = now.toISOString();
  try {
    await db.batch([
      db.prepare("INSERT INTO observation_publications(job_id,origin,available_at) VALUES(NULL,'baseline',?)").bind(stamp),
      db.prepare(`INSERT INTO observation_selections SELECT p.sequence,c.source,c.entity_id,c.observed_at,c.revision_id
        FROM current_observations c JOIN observation_publications p ON p.origin='baseline'`),
      db.prepare(`INSERT INTO derivation_jobs(id,kind,input_version,publication_sequence,created_at,updated_at)
        SELECT 'baseline','features','baseline',sequence,?,? FROM observation_publications WHERE origin='baseline'`).bind(stamp, stamp),
    ]);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('observation_publications.origin')) throw error;
  }
}

/** Predictions contain static input/support checks; serving applies the live 30-hour age policy. */
export async function predictionStatement(db: D1Database, bundle: Bundle, feature: Feature, now: Date): Promise<D1PreparedStatement> {
  const result = assess(bundle, feature, new Date(feature.observed_at));
  const id = await sha256(new TextEncoder().encode(`${feature.feature_revision}:${bundle.metadata.version}:${result.policy_version}`));
  return db.prepare(`INSERT INTO prediction_results(id,feature_snapshot_id,feature_version,model_version,policy_version,score,status,reason_code,computed_at)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(feature_snapshot_id,model_version,policy_version) DO NOTHING`)
    .bind(id, feature.feature_revision, feature.feature_version, bundle.metadata.version, result.policy_version, result.score, result.score === null ? 'unsupported' : 'scored', result.status, now.toISOString());
}

export async function deriveStep(db: D1Database, bucket: R2Bucket, clock: () => Date = () => new Date()) {
  const now = clock();
  const stamp = now.toISOString(); const token = crypto.randomUUID();
  const value = await db.prepare(`SELECT * FROM derivation_jobs WHERE status='pending' OR (status='running' AND lease_until<=?)
    ORDER BY created_at,id LIMIT 1`).bind(stamp).first();
  if (!value) return { status: 'idle' as const };
  const job = jobSchema.parse(value);
  const claimed = await db.prepare(`UPDATE derivation_jobs SET status='running',lease_token=?,lease_until=?,attempt_count=attempt_count+1,updated_at=?
    WHERE id=? AND (status='pending' OR (status='running' AND lease_until<=?))`).bind(token, new Date(now.getTime() + 120000).toISOString(), stamp, job.id, stamp).run();
  if (claimed.meta.changes !== 1) return { status: 'busy' as const };
  try {
    const registry = new ModelRegistry(db, bucket);
    const active = await registry.active();
    if (!active) throw new PipelineError('active_model_missing');
    const statements: D1PreparedStatement[] = [];
    let count = 0, entity = job.cursor_entity, time = job.cursor_time;
    switch (job.kind) {
      case 'features': {
        if (job.publication_sequence === null) throw new PipelineError('publication_missing');
        const publication = await db.prepare('SELECT available_at FROM observation_publications WHERE sequence=?').bind(job.publication_sequence).first<{ available_at: string }>();
        if (!publication) throw new PipelineError('publication_missing');
        const rows = await inputPage(db, job.publication_sequence, publication.available_at, entity, time, pageSize);
        count = rows.length;
        if (rows.length) {
          const release = await putJson(bucket, 'pipeline/releases', { format: 'safenight-release-v1', feature_version: 'environment-v1', publication_sequence: job.publication_sequence, available_cutoff: publication.available_at, inputs: rows });
          statements.push(db.prepare('INSERT INTO data_releases(id,manifest_object_key,manifest_sha256,available_cutoff,sealed_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING')
            .bind(release.sha256, release.object_key, release.sha256, publication.available_at, stamp));
          for (const row of rows) {
            const feature = await featureFromInput(row);
            if (feature) {
              statements.push(db.prepare(`INSERT INTO feature_snapshots(id,entity_id,as_of,available_cutoff,feature_version,data_release_id,observation_revision_id,location_revision_id,payload_json,created_at)
                VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`).bind(feature.feature_revision, feature.sensor_id, feature.observed_at, publication.available_at, feature.feature_version, release.sha256, row.observation_revision_id, row.location_revision_id, canonicalJson(feature), stamp));
              statements.push(await predictionStatement(db, active.bundle, feature, now));
            }
          }
          const last = rows[rows.length - 1]; entity = last.entity_id; time = last.observed_at;
        }
        break;
      }
      case 'rescore': {
        if (job.model_version === null) throw new PipelineError('rescore_model_missing');
        const bundle = await registry.version(job.model_version);
        const rows = z.array(z.object({ id: z.string(), payload_json: z.string() })).parse((await db.prepare('SELECT id,payload_json FROM feature_snapshots WHERE id>? AND created_at<=? ORDER BY id LIMIT ?').bind(entity, job.created_at, pageSize).all()).results);
        count = rows.length;
        for (const row of rows) statements.push(await predictionStatement(db, bundle, featureSchema.parse(JSON.parse(row.payload_json)), now));
        if (rows.length) entity = rows[rows.length - 1].id;
        break;
      }
      default: return unreachable(job.kind);
    }
    const guard = `derive:${token}`;
    const complete = count < pageSize;
    await db.batch([
      db.prepare(`INSERT INTO operation_guards(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM derivation_jobs
        WHERE id=? AND lease_token=? AND status='running' AND lease_until>? AND cursor_entity=? AND cursor_time=?) THEN 1 ELSE 0 END`)
        .bind(guard, job.id, token, clock().toISOString(), job.cursor_entity, job.cursor_time),
      ...statements,
      db.prepare(`UPDATE derivation_jobs SET status=?,cursor_entity=?,cursor_time=?,processed_rows=processed_rows+?,updated_at=?,finished_at=?,error_code=NULL,lease_token=NULL,lease_until=NULL WHERE id=?`)
        .bind(complete ? 'succeeded' : 'pending', entity, time, count, stamp, complete ? stamp : null, job.id),
      db.prepare('DELETE FROM operation_guards WHERE id=?').bind(guard),
    ]);
    return { status: complete ? 'succeeded' as const : 'pending' as const, job_id: job.id, processed_rows: job.processed_rows + count };
  } catch (error) {
    await db.prepare("UPDATE derivation_jobs SET error_code=?,updated_at=? WHERE id=? AND lease_token=?")
      .bind(error instanceof PipelineError ? error.code : 'derivation_failed', clock().toISOString(), job.id, token).run();
    throw error;
  } finally {
    // A crash leaves an expiring lease. An observed failure releases it for an explicit retry.
    await db.prepare("UPDATE derivation_jobs SET status='pending',lease_token=NULL,lease_until=NULL WHERE id=? AND status='running' AND lease_token=?").bind(job.id, token).run();
  }
}
function unreachable(value: never): never { throw new PipelineError(`unknown_derivation_${String(value)}`); }
