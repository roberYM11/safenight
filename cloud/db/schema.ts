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
