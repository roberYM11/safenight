import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, real, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const collectionJobs = sqliteTable('collection_jobs', {
  id: text('id').primaryKey(), source: text('source').notNull(), day: text('day').notNull(),
  kind: text('kind').notNull(), status: text('status').notNull(),
  page_no: integer('page_no').notNull(), page_size: integer('page_size').notNull(),
  total_count: integer('total_count'), fetched_rows: integer('fetched_rows').notNull(), inserted_rows: integer('inserted_rows').notNull(),
  error_code: text('error_code'), created_at: text('created_at').notNull(), updated_at: text('updated_at').notNull(), finished_at: text('finished_at'),
  lease_token: text('lease_token'), lease_until: text('lease_until'),
}, table => [
  uniqueIndex('collection_active_source').on(table.source).where(sql`${table.status} IN ('pending','running')`),
  index('collection_source_day').on(table.source, table.day),
  check('collection_page_size', sql`${table.page_size} BETWEEN 1 AND 200`),
]);

export const rawObjects = sqliteTable('raw_objects', {
  sha256: text('sha256').primaryKey(), source: text('source').notNull(), object_key: text('object_key').notNull(),
  size_bytes: integer('size_bytes').notNull(), created_at: text('created_at').notNull(),
});

export const observationRevisions = sqliteTable('observation_revisions', {
  id: text('id').primaryKey(), source: text('source').notNull(), entity_id: text('entity_id').notNull(),
  observed_at: text('observed_at').notNull(), published_at: text('published_at').notNull(),
  revision_rank: integer('revision_rank').notNull(), source_updated_at: text('source_updated_at'),
  payload_json: text('payload_json').notNull(), lat: real('lat'), lon: real('lon'),
  raw_sha: text('raw_sha').notNull().references(() => rawObjects.sha256), ingested_at: text('ingested_at').notNull(),
  legacy_id: text('legacy_id'), first_job_id: text('first_job_id').notNull().references(() => collectionJobs.id),
}, table => [index('revision_lookup').on(table.source, table.entity_id, table.observed_at), index('revision_raw').on(table.raw_sha), index('revision_job').on(table.first_job_id)]);

export const currentObservations = sqliteTable('current_observations', {
  source: text('source').notNull(), entity_id: text('entity_id').notNull(), observed_at: text('observed_at').notNull(),
  revision_id: text('revision_id').notNull().references(() => observationRevisions.id),
}, table => [primaryKey({ columns: [table.source, table.entity_id, table.observed_at] })]);

export const jobRevisions = sqliteTable('job_revisions', {
  job_id: text('job_id').notNull().references(() => collectionJobs.id),
  revision_id: text('revision_id').notNull().references(() => observationRevisions.id),
}, table => [primaryKey({ columns: [table.job_id, table.revision_id] })]);

export const latestObservations = sqliteTable('latest_observations', {
  source: text('source').notNull(), entity_id: text('entity_id').notNull(), observed_at: text('observed_at').notNull(),
  revision_id: text('revision_id').notNull().references(() => observationRevisions.id),
}, table => [primaryKey({ columns: [table.source, table.entity_id] })]);

export const jobPages = sqliteTable('job_pages', {
  job_id: text('job_id').notNull().references(() => collectionJobs.id), page_no: integer('page_no').notNull(),
  page_hash: text('page_hash').notNull(), record_count: integer('record_count').notNull(),
}, table => [primaryKey({ columns: [table.job_id, table.page_no] }), index('page_fingerprint').on(table.job_id, table.page_hash)]);

export const sourceCheckpoints = sqliteTable('source_checkpoints', {
  source: text('source').primaryKey(), covered_until: text('covered_until').notNull(),
});

export const operationGuards = sqliteTable('operation_guards', {
  id: text('id').primaryKey(), ok: integer('ok').notNull(),
}, table => [check('operation_guard_ok', sql`${table.ok} = 1`)]);

export const populationRawObjects = sqliteTable('population_raw_objects', {
  sha256: text('sha256').primaryKey(), object_key: text('object_key').notNull(),
  size_bytes: integer('size_bytes').notNull(), first_area_code: text('first_area_code').notNull(),
  http_status: integer('http_status').notNull(), source_url: text('source_url').notNull(), retrieved_at: text('retrieved_at').notNull(),
}, table => [check('population_raw_size', sql`${table.size_bytes} BETWEEN 0 AND 1048576`), check('population_raw_http_status', sql`${table.http_status} BETWEEN 100 AND 599`)]);

export const populationObservations = sqliteTable('population_observations', {
  id: text('id').primaryKey(), area_code: text('area_code').notNull(), observed_at: text('observed_at').notNull(),
  raw_sha256: text('raw_sha256').notNull().references(() => populationRawObjects.sha256),
  payload_json: text('payload_json').notNull(), source_url: text('source_url').notNull(), inserted_at: text('inserted_at').notNull(),
}, table => [
  uniqueIndex('population_observation_identity').on(table.area_code, table.observed_at, table.raw_sha256),
  index('population_observation_area_time').on(table.area_code, table.observed_at),
]);

export const populationCache = sqliteTable('population_cache', {
  area_code: text('area_code').primaryKey(), observation_id: text('observation_id').notNull().references(() => populationObservations.id),
  retrieved_at: text('retrieved_at').notNull(), expires_at: text('expires_at').notNull(),
});

export const contextSnapshots = sqliteTable('context_snapshots', {
  id: text('id').primaryKey(), object_key: text('object_key').notNull(), artifact_sha256: text('artifact_sha256').notNull(),
  sources_json: text('sources_json').notNull(), source_count: integer('source_count').notNull(), facility_count: integer('facility_count').notNull(), created_at: text('created_at').notNull(),
});
export const contextCurrent = sqliteTable('context_current', {
  scope: text('scope').primaryKey(), snapshot_id: text('snapshot_id').notNull().references(() => contextSnapshots.id), checked_at: text('checked_at').notNull(),
});
export const contextRefreshJobs = sqliteTable('context_refresh_jobs', {
  id: text('id').primaryKey(), scope: text('scope').notNull(), day: text('day').notNull(), status: text('status').notNull(),
  next_source_index: integer('next_source_index').notNull(), created_at: text('created_at').notNull(), updated_at: text('updated_at').notNull(), finished_at: text('finished_at'),
  error_code: text('error_code'), snapshot_id: text('snapshot_id').references(() => contextSnapshots.id), unchanged: integer('unchanged').notNull(),
  lease_token: text('lease_token'), lease_until: text('lease_until'),
}, table => [
  uniqueIndex('context_active_job').on(table.scope).where(sql`${table.status} = 'running'`),
  uniqueIndex('context_successful_day').on(table.scope, table.day).where(sql`${table.status} = 'succeeded'`),
  check('context_source_cursor', sql`${table.next_source_index} BETWEEN 0 AND 4`),
]);
export const contextRawDocuments = sqliteTable('context_raw_documents', {
  id: text('id').primaryKey(), job_id: text('job_id').notNull().references(() => contextRefreshJobs.id), source_id: text('source_id').notNull(),
  role: text('role').notNull(), url: text('url').notNull(), sha256: text('sha256').notNull(), object_key: text('object_key').notNull(),
  size_bytes: integer('size_bytes').notNull(), content_type: text('content_type').notNull(), retrieved_at: text('retrieved_at').notNull(),
}, table => [index('context_raw_job_source').on(table.job_id, table.source_id), check('context_raw_size', sql`${table.size_bytes} BETWEEN 0 AND 10485760`)]);
export const contextStagedSources = sqliteTable('context_staged_sources', {
  job_id: text('job_id').notNull().references(() => contextRefreshJobs.id), source_id: text('source_id').notNull(), source_index: integer('source_index').notNull(),
  object_key: text('object_key').notNull(), artifact_sha256: text('artifact_sha256').notNull(), semantic_id: text('semantic_id').notNull(), stored_at: text('stored_at').notNull(),
}, table => [primaryKey({ columns: [table.job_id, table.source_id] }), uniqueIndex('context_stage_cursor').on(table.job_id, table.source_index)]);
// Publication time is the system visibility time, independent of provider timestamps.
export const observationPublications = sqliteTable('observation_publications', {
  sequence: integer('sequence').primaryKey({ autoIncrement: true }),
  job_id: text('job_id').references(() => collectionJobs.id), origin: text('origin').notNull().default('collection'),
  available_at: text('available_at').notNull(),
}, table => [uniqueIndex('publication_job').on(table.job_id), index('publication_available').on(table.available_at),
  uniqueIndex('publication_baseline').on(table.origin).where(sql`${table.origin} = 'baseline'`),
  check('publication_origin', sql`(${table.origin} = 'collection' AND ${table.job_id} IS NOT NULL) OR (${table.origin} = 'baseline' AND ${table.job_id} IS NULL)`),
]);

export const observationSelections = sqliteTable('observation_selections', {
  publication_sequence: integer('publication_sequence').notNull().references(() => observationPublications.sequence),
  source: text('source').notNull(), entity_id: text('entity_id').notNull(), observed_at: text('observed_at').notNull(),
  revision_id: text('revision_id').notNull().references(() => observationRevisions.id),
}, table => [
  primaryKey({ columns: [table.publication_sequence, table.source, table.entity_id, table.observed_at] }),
  index('selection_asof').on(table.source, table.entity_id, table.observed_at, table.publication_sequence),
]);

export const derivationJobs = sqliteTable('derivation_jobs', {
  id: text('id').primaryKey(), kind: text('kind').notNull(), input_version: text('input_version').notNull(),
  publication_sequence: integer('publication_sequence').references(() => observationPublications.sequence),
  model_version: text('model_version').references(() => modelArtifacts.version),
  status: text('status').notNull().default('pending'), attempt_count: integer('attempt_count').notNull().default(0),
  cursor_entity: text('cursor_entity').notNull().default(''), cursor_time: text('cursor_time').notNull().default(''), processed_rows: integer('processed_rows').notNull().default(0),
  lease_token: text('lease_token'), lease_until: text('lease_until'), error_code: text('error_code'),
  created_at: text('created_at').notNull(), updated_at: text('updated_at').notNull(), finished_at: text('finished_at'),
}, table => [
  uniqueIndex('derivation_input').on(table.kind, table.input_version), index('derivation_pending').on(table.status, table.lease_until),
  check('derivation_status', sql`${table.status} IN ('pending','running','succeeded','failed')`),
  check('derivation_attempts', sql`${table.attempt_count} >= 0`),
  check('derivation_lease', sql`(${table.status} = 'running' AND ${table.lease_token} IS NOT NULL AND ${table.lease_until} IS NOT NULL) OR (${table.status} <> 'running' AND ${table.lease_token} IS NULL AND ${table.lease_until} IS NULL)`),
]);

// Only sealed releases belong here. Manifests contain exact member IDs, not mutable queries.
export const dataReleases = sqliteTable('data_releases', {
  id: text('id').primaryKey(), manifest_object_key: text('manifest_object_key').notNull(), manifest_sha256: text('manifest_sha256').notNull(),
  available_cutoff: text('available_cutoff').notNull(), sealed_at: text('sealed_at').notNull(),
}, table => [check('release_cutoff', sql`${table.available_cutoff} <= ${table.sealed_at}`)]);

export const featureSnapshots = sqliteTable('feature_snapshots', {
  id: text('id').primaryKey(), entity_id: text('entity_id').notNull(), as_of: text('as_of').notNull(),
  available_cutoff: text('available_cutoff').notNull(), feature_version: text('feature_version').notNull(),
  data_release_id: text('data_release_id').notNull().references(() => dataReleases.id),
  observation_revision_id: text('observation_revision_id').notNull().references(() => observationRevisions.id),
  location_revision_id: text('location_revision_id').notNull().references(() => observationRevisions.id),
  payload_json: text('payload_json').notNull(), created_at: text('created_at').notNull(),
}, table => [
  uniqueIndex('feature_grain').on(table.entity_id, table.as_of, table.feature_version, table.data_release_id, table.available_cutoff),
  uniqueIndex('feature_identity_version').on(table.id, table.feature_version),
  index('feature_observation').on(table.observation_revision_id), index('feature_location').on(table.location_revision_id),
  check('feature_payload', sql`json_valid(${table.payload_json})`),
  check('feature_asof', sql`${table.as_of} <= ${table.available_cutoff}`),
]);

export const targetDefinitions = sqliteTable('target_definitions', {
  version: text('version').primaryKey(), kind: text('kind').notNull(), description: text('description').notNull(),
  definition_object_key: text('definition_object_key').notNull(), definition_sha256: text('definition_sha256').notNull(),
  horizon_seconds: integer('horizon_seconds'), created_at: text('created_at').notNull(),
}, table => [check('target_kind_horizon', sql`(${table.kind} = 'rule_index' AND ${table.horizon_seconds} IS NULL) OR (${table.kind} = 'future_observation' AND ${table.horizon_seconds} > 0 AND ${table.horizon_seconds} IS NOT NULL)`)]);

export const targetValues = sqliteTable('target_values', {
  id: text('id').primaryKey(), feature_snapshot_id: text('feature_snapshot_id').notNull().references(() => featureSnapshots.id),
  target_version: text('target_version').notNull().references(() => targetDefinitions.version),
  value: real('value').notNull(), target_time: text('target_time').notNull(), available_at: text('available_at').notNull(),
  object_key: text('object_key').notNull(), sha256: text('sha256').notNull(),
}, table => [uniqueIndex('target_feature_version').on(table.feature_snapshot_id, table.target_version), check('target_value_range', sql`${table.value} BETWEEN 0 AND 100`)]);

export const datasetSnapshots = sqliteTable('dataset_snapshots', {
  id: text('id').primaryKey(), data_release_id: text('data_release_id').notNull().references(() => dataReleases.id),
  object_key: text('object_key').notNull(), sha256: text('sha256').notNull(),
  feature_version: text('feature_version').notNull(), target_version: text('target_version').notNull().references(() => targetDefinitions.version),
  split_policy_json: text('split_policy_json').notNull(), row_count: integer('row_count').notNull(), created_at: text('created_at').notNull(),
}, table => [
  check('dataset_rows', sql`${table.row_count} > 0`), check('dataset_split', sql`json_valid(${table.split_policy_json})`),
  uniqueIndex('dataset_identity_versions').on(table.id, table.feature_version, table.target_version),
]);

export const trainingRuns = sqliteTable('training_runs', {
  id: text('id').primaryKey(), dataset_id: text('dataset_id').notNull(),
  feature_version: text('feature_version').notNull(), target_version: text('target_version').notNull(),
  code_sha: text('code_sha').notNull(), seed: integer('seed').notNull(), status: text('status').notNull(),
  parameters_json: text('parameters_json').notNull(), metrics_json: text('metrics_json'), baseline_metrics_json: text('baseline_metrics_json'),
  evaluation_policy_version: text('evaluation_policy_version').notNull(), error_code: text('error_code'),
  started_at: text('started_at').notNull(), finished_at: text('finished_at'),
}, table => [
  foreignKey({ columns: [table.dataset_id, table.feature_version, table.target_version], foreignColumns: [datasetSnapshots.id, datasetSnapshots.feature_version, datasetSnapshots.target_version] }),
  uniqueIndex('training_identity_versions').on(table.id, table.feature_version, table.target_version),
  uniqueIndex('training_active_dataset').on(table.dataset_id).where(sql`${table.status} = 'running'`),
  check('training_status', sql`${table.status} IN ('running','succeeded','failed')`),
  check('training_parameters', sql`json_valid(${table.parameters_json})`),
  check('training_metrics', sql`${table.metrics_json} IS NULL OR json_valid(${table.metrics_json})`),
  check('training_baselines', sql`${table.baseline_metrics_json} IS NULL OR json_valid(${table.baseline_metrics_json})`),
  check('training_success', sql`${table.status} <> 'succeeded' OR (${table.metrics_json} IS NOT NULL AND ${table.baseline_metrics_json} IS NOT NULL AND ${table.finished_at} IS NOT NULL)`),
]);

export const modelArtifacts = sqliteTable('model_artifacts', {
  version: text('version').primaryKey(), training_run_id: text('training_run_id'), origin: text('origin').notNull().default('trained'),
  feature_version: text('feature_version').notNull(), target_version: text('target_version').notNull(),
  object_key: text('object_key').notNull(), digest: text('digest').notNull(), manifest_json: text('manifest_json').notNull(),
  approval_status: text('approval_status').notNull().default('candidate'), approved_by: text('approved_by'), approved_at: text('approved_at'),
  created_at: text('created_at').notNull(),
}, table => [
  foreignKey({ columns: [table.training_run_id, table.feature_version, table.target_version], foreignColumns: [trainingRuns.id, trainingRuns.feature_version, trainingRuns.target_version] }),
  uniqueIndex('model_identity_feature').on(table.version, table.feature_version),
  check('model_manifest', sql`json_valid(${table.manifest_json})`),
  check('model_approval_status', sql`${table.approval_status} IN ('candidate','approved','rejected')`),
  check('model_approval_record', sql`${table.approval_status} <> 'approved' OR (${table.approved_by} IS NOT NULL AND ${table.approved_at} IS NOT NULL)`),
  check('model_origin', sql`(${table.origin} = 'trained' AND ${table.training_run_id} IS NOT NULL) OR (${table.origin} = 'bundled' AND ${table.training_run_id} IS NULL)`),
]);

export const modelActivations = sqliteTable('model_activations', {
  name: text('name').notNull(), generation: integer('generation').notNull(),
  model_version: text('model_version').notNull().references(() => modelArtifacts.version),
  previous_version: text('previous_version').references(() => modelArtifacts.version),
  reason: text('reason').notNull(), activated_by: text('activated_by').notNull(), activated_at: text('activated_at').notNull(),
}, table => [
  primaryKey({ columns: [table.name, table.generation] }), check('activation_generation', sql`${table.generation} >= 1`),
  uniqueIndex('activation_identity_model').on(table.name, table.generation, table.model_version),
]);

export const activeModels = sqliteTable('active_models', {
  name: text('name').primaryKey(), generation: integer('generation').notNull(), model_version: text('model_version').notNull(),
}, table => [foreignKey({ columns: [table.name, table.generation, table.model_version], foreignColumns: [modelActivations.name, modelActivations.generation, modelActivations.model_version] })]);

export const predictionResults = sqliteTable('prediction_results', {
  id: text('id').primaryKey(), feature_snapshot_id: text('feature_snapshot_id').notNull(), feature_version: text('feature_version').notNull(),
  model_version: text('model_version').notNull(), policy_version: text('policy_version').notNull(),
  score: real('score'), status: text('status').notNull(), reason_code: text('reason_code'), computed_at: text('computed_at').notNull(),
}, table => [
  foreignKey({ columns: [table.feature_snapshot_id, table.feature_version], foreignColumns: [featureSnapshots.id, featureSnapshots.feature_version] }),
  foreignKey({ columns: [table.model_version, table.feature_version], foreignColumns: [modelArtifacts.version, modelArtifacts.feature_version] }),
  uniqueIndex('prediction_input_model_policy').on(table.feature_snapshot_id, table.model_version, table.policy_version),
  check('prediction_status_score', sql`(${table.status} = 'scored' AND ${table.score} IS NOT NULL AND ${table.score} BETWEEN 0 AND 100) OR (${table.status} = 'unsupported' AND ${table.score} IS NULL AND ${table.reason_code} IS NOT NULL)`),
]);

export const pointAssessments = sqliteTable('point_assessments', {
  id: text('id').primaryKey(), lat: real('lat').notNull(), lon: real('lon').notNull(), as_of: text('as_of').notNull(),
  data_release_id: text('data_release_id').notNull().references(() => dataReleases.id),
  policy_version: text('policy_version').notNull(), score: real('score'), status: text('status').notNull(),
  reason_code: text('reason_code'), computed_at: text('computed_at').notNull(),
}, table => [
  check('point_coordinates', sql`${table.lat} BETWEEN -90 AND 90 AND ${table.lon} BETWEEN -180 AND 180`),
  check('point_status_score', sql`(${table.status} = 'scored' AND ${table.score} IS NOT NULL AND ${table.score} BETWEEN 0 AND 100) OR (${table.status} = 'unsupported' AND ${table.score} IS NULL AND ${table.reason_code} IS NOT NULL)`),
]);

export const pointContributors = sqliteTable('point_contributors', {
  assessment_id: text('assessment_id').notNull().references(() => pointAssessments.id),
  prediction_id: text('prediction_id').notNull().references(() => predictionResults.id),
  distance_m: real('distance_m').notNull(), weight: real('weight').notNull(),
}, table => [
  primaryKey({ columns: [table.assessment_id, table.prediction_id] }),
  check('contributor_distance_weight', sql`${table.distance_m} >= 0 AND ${table.weight} > 0 AND ${table.weight} <= 1`),
]);

export const populationRequestLeases = sqliteTable('population_request_leases', {
  area_code: text('area_code').primaryKey(), token: text('token').notNull(), lease_until: text('lease_until').notNull(), next_allowed_at: text('next_allowed_at').notNull(),
});
