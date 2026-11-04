import { z } from 'zod';
import { loadBundle } from '../forest.ts';
import type { Bundle } from '../forest.ts';
import { PipelineError, readBytes } from './objects.ts';

const selected = z.object({ name: z.string(), generation: z.number().int(), model_version: z.string(), object_key: z.string(), digest: z.string(), manifest_json: z.string(), approval_status: z.string() });
export type ActiveModel = { readonly generation: number; readonly bundle: Bundle };
// Bounded cache for immutable artifacts only. Active pointers and approval are always read again.
const verifiedModels = new WeakMap<R2Bucket, Map<string, Promise<Bundle>>>();

export class ModelRegistry {
  readonly db: D1Database; readonly bucket: R2Bucket;
  constructor(db: D1Database, bucket: R2Bucket) { this.db = db; this.bucket = bucket; }

  /** Read the pointer on each request; cache only immutable, digest-verified bytes. */
  async active(): Promise<ActiveModel | null> {
    const value = await this.db.prepare(`SELECT a.*,m.object_key,m.digest,m.manifest_json,m.approval_status
      FROM active_models a JOIN model_artifacts m ON m.version=a.model_version WHERE a.name='environment'`).first();
    if (!value) return null;
    const row = selected.parse(value);
    if (row.approval_status !== 'approved') throw new PipelineError('active_model_not_approved');
    const bundle = await this.loadArtifact(row);
    if (bundle.metadata.version !== row.model_version) throw new PipelineError('active_model_version_mismatch');
    return { generation: row.generation, bundle };
  }

  private async loadArtifact(row: { readonly model_version: string; readonly object_key: string; readonly digest: string; readonly manifest_json: string }): Promise<Bundle> {
    const cache = verifiedModels.get(this.bucket) ?? new Map<string, Promise<Bundle>>();
    verifiedModels.set(this.bucket, cache);
    const key = `${row.model_version}:${row.digest}`;
    const prior = cache.get(key);
    if (prior) return prior;
    const loading = readBytes(this.bucket, row.object_key, row.digest).then(bytes => loadBundle(new TextDecoder().decode(bytes), row.manifest_json));
    cache.set(key, loading);
    if (cache.size > 3) { const oldest = cache.keys().next().value; if (oldest) cache.delete(oldest); }
    try { return await loading; }
    catch (error) { cache.delete(key); throw error; }
  }

  async version(version: string): Promise<Bundle> {
    const row = await this.db.prepare("SELECT version AS model_version,object_key,digest,manifest_json FROM model_artifacts WHERE version=? AND approval_status='approved'")
      .bind(version).first<{ model_version: string; object_key: string; digest: string; manifest_json: string }>();
    if (!row) throw new PipelineError('model_not_approved');
    return this.loadArtifact(row);
  }

  /** Import the already deployed bundle without pretending it passed new quality gates. */
  async bootstrap(modelText: string, manifestText: string, now: Date): Promise<ActiveModel> {
    const current = await this.active();
    if (current) return current;
    const bundle = await loadBundle(modelText, manifestText);
    const digest = bundle.metadata.artifact_sha256;
    const key = `models/${digest}.json`;
    if (!await this.bucket.head(key)) await this.bucket.put(key, new TextEncoder().encode(modelText));
    await readBytes(this.bucket, key, digest);
    await this.db.prepare(`INSERT INTO model_artifacts(version,training_run_id,origin,feature_version,target_version,object_key,digest,manifest_json,approval_status,approved_by,approved_at,created_at)
      VALUES(?,NULL,'bundled','environment-v1','legacy-imported-rule-index',?,?,?,'approved','existing-deployment',?,?) ON CONFLICT DO NOTHING`)
      .bind(bundle.metadata.version, key, digest, manifestText, now.toISOString(), now.toISOString()).run();
    try { await this.activate(bundle.metadata.version, 0, 'existing-deployment', 'bootstrap existing deployed bundle; no new performance claim', now); }
    catch (error) { if (!(error instanceof PipelineError) || error.code !== 'model_generation_conflict') throw error; }
    const active = await this.active();
    if (!active) throw new PipelineError('active_model_missing');
    return active;
  }

  async approve(version: string, actor: string, now: Date): Promise<void> {
    const row = await this.db.prepare(`SELECT t.metrics_json FROM model_artifacts m JOIN training_runs t ON t.id=m.training_run_id
      WHERE m.version=? AND m.origin='trained' AND t.status='succeeded'`).bind(version).first<{ metrics_json: string }>();
    if (!row) throw new PipelineError('model_quality_gate_failed');
    const report = z.object({ passed: z.literal(true), incumbent_version: z.string() }).safeParse(JSON.parse(row.metrics_json));
    if (!report.success) throw new PipelineError('model_quality_gate_failed');
    const active = await this.db.prepare("SELECT model_version FROM active_models WHERE name='environment'").first<{ model_version: string }>();
    if (active?.model_version !== report.data.incumbent_version) throw new PipelineError('model_reevaluation_required');
    await this.db.prepare("UPDATE model_artifacts SET approval_status='approved',approved_by=?,approved_at=? WHERE version=? AND approval_status='candidate'")
      .bind(actor, now.toISOString(), version).run();
  }

  /** CAS, audit event and re-score outbox are committed together. Rollback uses a new generation. */
  async activate(version: string, expectedGeneration: number, actor: string, reason: string, now: Date): Promise<void> {
    const candidate = await this.db.prepare("SELECT origin,approval_status FROM model_artifacts WHERE version=?").bind(version).first<{ origin: string; approval_status: string }>();
    if (!candidate || candidate.approval_status !== 'approved') throw new PipelineError('model_not_approved');
    const generation = expectedGeneration + 1;
    const priorActivation = await this.db.prepare('SELECT 1 FROM model_activations WHERE model_version=? LIMIT 1').bind(version).first();
    let evaluatedIncumbent: string | null = null;
    if (candidate.origin === 'trained' && !priorActivation) {
      const evidence = await this.db.prepare('SELECT t.metrics_json FROM training_runs t JOIN model_artifacts m ON m.training_run_id=t.id WHERE m.version=?').bind(version).first<{ metrics_json: string }>();
      const report = z.object({ passed: z.literal(true), incumbent_version: z.string() }).safeParse(evidence ? JSON.parse(evidence.metrics_json) : null);
      if (!report.success) throw new PipelineError('model_quality_gate_failed');
      evaluatedIncumbent = report.data.incumbent_version;
    }
    const guard = `model:${crypto.randomUUID()}`;
    const stamp = now.toISOString();
    try {
      await this.db.batch([
        this.db.prepare(`INSERT INTO operation_guards(id,ok) SELECT ?,CASE WHEN COALESCE((SELECT generation FROM active_models WHERE name='environment'),0)=?
          AND EXISTS(SELECT 1 FROM model_artifacts WHERE version=? AND approval_status='approved')
          AND (? IS NULL OR (SELECT model_version FROM active_models WHERE name='environment')=?) THEN 1 ELSE 0 END`).bind(guard, expectedGeneration, version, evaluatedIncumbent, evaluatedIncumbent),
        this.db.prepare(`INSERT INTO model_activations(name,generation,model_version,previous_version,reason,activated_by,activated_at)
          SELECT 'environment',?,?,(SELECT model_version FROM active_models WHERE name='environment'),?,?,?`).bind(generation, version, reason, actor, stamp),
        this.db.prepare(`INSERT INTO active_models(name,generation,model_version) VALUES('environment',?,?)
          ON CONFLICT(name) DO UPDATE SET generation=excluded.generation,model_version=excluded.model_version`).bind(generation, version),
        this.db.prepare(`INSERT INTO derivation_jobs(id,kind,input_version,model_version,created_at,updated_at) VALUES(?,'rescore',?,?,?,?)`)
          .bind(`rescore:${generation}`, `environment:${generation}:${version}`, version, stamp, stamp),
        this.db.prepare('DELETE FROM operation_guards WHERE id=?').bind(guard),
      ]);
    } catch (error) {
      if (error instanceof Error && (error.message.includes('operation_guard_ok') || error.message.includes('model_activations.name'))) throw new PipelineError('model_generation_conflict');
      throw error;
    }
  }
}
