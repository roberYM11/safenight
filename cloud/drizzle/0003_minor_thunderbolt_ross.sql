CREATE TABLE `context_current` (
	`scope` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`checked_at` text NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `context_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `context_raw_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`source_id` text NOT NULL,
	`role` text NOT NULL,
	`url` text NOT NULL,
	`sha256` text NOT NULL,
	`object_key` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`content_type` text NOT NULL,
	`retrieved_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `context_refresh_jobs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "context_raw_size" CHECK("context_raw_documents"."size_bytes" BETWEEN 0 AND 10485760)
);
--> statement-breakpoint
CREATE INDEX `context_raw_job_source` ON `context_raw_documents` (`job_id`,`source_id`);--> statement-breakpoint
CREATE TABLE `context_refresh_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`day` text NOT NULL,
	`status` text NOT NULL,
	`next_source_index` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`finished_at` text,
	`error_code` text,
	`snapshot_id` text,
	`unchanged` integer NOT NULL,
	`lease_token` text,
	`lease_until` text,
	FOREIGN KEY (`snapshot_id`) REFERENCES `context_snapshots`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "context_source_cursor" CHECK("context_refresh_jobs"."next_source_index" BETWEEN 0 AND 4)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `context_active_job` ON `context_refresh_jobs` (`scope`) WHERE "context_refresh_jobs"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX `context_successful_day` ON `context_refresh_jobs` (`scope`,`day`) WHERE "context_refresh_jobs"."status" = 'succeeded';--> statement-breakpoint
CREATE TABLE `context_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`object_key` text NOT NULL,
	`artifact_sha256` text NOT NULL,
	`sources_json` text NOT NULL,
	`source_count` integer NOT NULL,
	`facility_count` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `context_staged_sources` (
	`job_id` text NOT NULL,
	`source_id` text NOT NULL,
	`source_index` integer NOT NULL,
	`object_key` text NOT NULL,
	`artifact_sha256` text NOT NULL,
	`semantic_id` text NOT NULL,
	`stored_at` text NOT NULL,
	PRIMARY KEY(`job_id`, `source_id`),
	FOREIGN KEY (`job_id`) REFERENCES `context_refresh_jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `context_stage_cursor` ON `context_staged_sources` (`job_id`,`source_index`);