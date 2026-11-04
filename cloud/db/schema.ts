import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text, real, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
