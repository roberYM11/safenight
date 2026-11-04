CREATE TABLE `collection_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`day` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`page_no` integer NOT NULL,
	`page_size` integer NOT NULL,
	`total_count` integer,
	`fetched_rows` integer NOT NULL,
	`inserted_rows` integer NOT NULL,
	`error_code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`finished_at` text,
	`lease_token` text,
	`lease_until` text,
	CONSTRAINT "collection_page_size" CHECK("collection_jobs"."page_size" BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collection_active_source` ON `collection_jobs` (`source`) WHERE "collection_jobs"."status" IN ('pending','running');--> statement-breakpoint
CREATE INDEX `collection_source_day` ON `collection_jobs` (`source`,`day`);--> statement-breakpoint
CREATE TABLE `current_observations` (
	`source` text NOT NULL,
	`entity_id` text NOT NULL,
	`observed_at` text NOT NULL,
	`revision_id` text NOT NULL,
	PRIMARY KEY(`source`, `entity_id`, `observed_at`),
	FOREIGN KEY (`revision_id`) REFERENCES `observation_revisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `job_pages` (
	`job_id` text NOT NULL,
	`page_no` integer NOT NULL,
	`page_hash` text NOT NULL,
	`record_count` integer NOT NULL,
	PRIMARY KEY(`job_id`, `page_no`),
	FOREIGN KEY (`job_id`) REFERENCES `collection_jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `page_fingerprint` ON `job_pages` (`job_id`,`page_hash`);--> statement-breakpoint
CREATE TABLE `job_revisions` (
	`job_id` text NOT NULL,
	`revision_id` text NOT NULL,
	PRIMARY KEY(`job_id`, `revision_id`),
	FOREIGN KEY (`job_id`) REFERENCES `collection_jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`revision_id`) REFERENCES `observation_revisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `observation_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`entity_id` text NOT NULL,
	`observed_at` text NOT NULL,
	`published_at` text NOT NULL,
	`revision_rank` integer NOT NULL,
	`source_updated_at` text,
	`payload_json` text NOT NULL,
	`lat` real,
	`lon` real,
	`raw_sha` text NOT NULL,
	`ingested_at` text NOT NULL,
	`legacy_id` text,
	`first_job_id` text NOT NULL,
	FOREIGN KEY (`raw_sha`) REFERENCES `raw_objects`(`sha256`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`first_job_id`) REFERENCES `collection_jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `revision_lookup` ON `observation_revisions` (`source`,`entity_id`,`observed_at`);--> statement-breakpoint
CREATE INDEX `revision_raw` ON `observation_revisions` (`raw_sha`);--> statement-breakpoint
CREATE TABLE `operation_guards` (
	`id` text PRIMARY KEY NOT NULL,
	`ok` integer NOT NULL,
	CONSTRAINT "operation_guard_ok" CHECK("operation_guards"."ok" = 1)
);
--> statement-breakpoint
CREATE TABLE `raw_objects` (
	`sha256` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`object_key` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `source_checkpoints` (
	`source` text PRIMARY KEY NOT NULL,
	`covered_until` text NOT NULL
);
