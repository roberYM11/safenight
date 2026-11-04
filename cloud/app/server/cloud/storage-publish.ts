import type { CollectionJob } from './contracts.ts';
import { clearGuard, CloudStoreError, dayWindow, getInternal, guardedBatch, leaseGuard, publicJob, requireLease } from './storage-rows.ts';

// A current revision is included only for the observation keys touched by this job.
const pool = `WITH staged AS (
 SELECT r.* FROM observation_revisions r JOIN job_revisions j ON j.revision_id=r.id WHERE j.job_id=?
), touched AS (SELECT DISTINCT source,entity_id,observed_at FROM staged), pool AS (
 SELECT * FROM staged UNION
 SELECT r.* FROM touched t JOIN current_observations c ON t.source=c.source AND t.entity_id=c.entity_id AND t.observed_at=c.observed_at JOIN observation_revisions r ON r.id=c.revision_id
), priorities AS (
 SELECT p.*,MAX(revision_rank) OVER(PARTITION BY source,entity_id,observed_at) AS top_rank FROM pool p
), highest AS (
 SELECT * FROM priorities WHERE revision_rank=top_rank
)`;
const conflicts = `${pool} SELECT COUNT(*) AS value FROM highest a JOIN highest b
 ON a.source=b.source AND a.entity_id=b.entity_id AND a.observed_at=b.observed_at AND a.id<b.id
 WHERE NOT(a.source_updated_at IS NOT NULL AND b.source_updated_at IS NOT NULL AND a.source_updated_at<>b.source_updated_at)
 AND NOT(a.payload_json=b.payload_json AND a.lat IS b.lat AND a.lon IS b.lon)`;
const winners = `${pool}, ranked AS (
 SELECT p.*,ROW_NUMBER() OVER(PARTITION BY source,entity_id,observed_at ORDER BY revision_rank DESC,source_updated_at DESC,id) AS winner FROM pool p
) INSERT INTO current_observations(source,entity_id,observed_at,revision_id)
 SELECT source,entity_id,observed_at,id FROM ranked WHERE winner=1
 ON CONFLICT(source,entity_id,observed_at) DO UPDATE SET revision_id=excluded.revision_id`;
const latest=`WITH touched AS (
 SELECT DISTINCT r.source,r.entity_id FROM observation_revisions r JOIN job_revisions j ON j.revision_id=r.id WHERE j.job_id=?
) INSERT INTO latest_observations(source,entity_id,observed_at,revision_id)
 SELECT c.source,c.entity_id,c.observed_at,c.revision_id FROM touched t JOIN current_observations c
 ON c.source=t.source AND c.entity_id=t.entity_id AND c.observed_at=(SELECT MAX(q.observed_at) FROM current_observations q WHERE q.source=t.source AND q.entity_id=t.entity_id)
 WHERE 1 ON CONFLICT(source,entity_id) DO UPDATE SET observed_at=excluded.observed_at,revision_id=excluded.revision_id`;

/** Complete one validated job in a single D1 transaction; no partial pointers escape. */
export async function publishJob(db:D1Database,id:string,token:string,now:Date):Promise<CollectionJob> {
  const initial=await getInternal(db,id);
  if (initial?.status==='succeeded') return publicJob(initial);
  const job=requireLease(initial,token,now);
  if (job.total_count===null || job.fetched_rows!==job.total_count) throw new CloudStoreError('invalid_page_length');
  const window=dayWindow(job.day);
  const checkpoint=await db.prepare('SELECT covered_until FROM source_checkpoints WHERE source=?').bind(job.source).first<{covered_until:string}>();
  if (job.source==='sdot' && checkpoint && window.start>checkpoint.covered_until) throw new CloudStoreError('coverage_gap');
  const conflict=await db.prepare(conflicts).bind(id).first<{value:number}>();
  if (conflict && conflict.value>0) throw new CloudStoreError('revision_conflict');
  const statements:D1PreparedStatement[]=[leaseGuard(db,job,token,now),db.prepare(winners).bind(id),db.prepare(latest).bind(id)];
  // History and the outbox commit with the pointers, including when the worker
  // exits immediately after this batch. Retrying a successful job creates neither twice.
  statements.push(
    db.prepare('INSERT INTO observation_publications(job_id,available_at) VALUES(?,?)').bind(id,now.toISOString()),
    db.prepare(`WITH touched AS (
      SELECT DISTINCT r.source,r.entity_id,r.observed_at FROM job_revisions j
      JOIN observation_revisions r ON r.id=j.revision_id WHERE j.job_id=?
    ) INSERT INTO observation_selections(publication_sequence,source,entity_id,observed_at,revision_id)
      SELECT p.sequence,c.source,c.entity_id,c.observed_at,c.revision_id
      FROM touched t JOIN current_observations c
      ON c.source=t.source AND c.entity_id=t.entity_id AND c.observed_at=t.observed_at
      JOIN observation_publications p ON p.job_id=?`).bind(id,id),
    db.prepare(`INSERT INTO derivation_jobs(id,kind,input_version,publication_sequence,created_at,updated_at)
      SELECT ?,'features',?,sequence,?,? FROM observation_publications WHERE job_id=?`)
      .bind(`derive:${id}`,`publication:${id}`,now.toISOString(),now.toISOString(),id),
  );
  if (job.source==='sdot') statements.push(db.prepare(`INSERT INTO source_checkpoints(source,covered_until) VALUES(?,?) ON CONFLICT(source) DO UPDATE SET covered_until=MAX(covered_until,excluded.covered_until)`).bind(job.source,window.end));
  statements.push(db.prepare(`UPDATE collection_jobs SET status='succeeded',finished_at=?,updated_at=?,lease_token=NULL,lease_until=NULL,error_code=NULL WHERE id=?`).bind(now.toISOString(),now.toISOString(),id),clearGuard(db,`lease:${id}`));
  await guardedBatch(db,statements);
  const result=await getInternal(db,id);
  if (!result) throw new CloudStoreError('job_missing');
  return publicJob(result);
}
