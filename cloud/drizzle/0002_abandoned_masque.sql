CREATE TABLE `population_cache` (
	`area_code` text PRIMARY KEY NOT NULL,
	`observation_id` text NOT NULL,
	`retrieved_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`observation_id`) REFERENCES `population_observations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `population_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`area_code` text NOT NULL,
	`observed_at` text NOT NULL,
	`raw_sha256` text NOT NULL,
	`payload_json` text NOT NULL,
	`source_url` text NOT NULL,
	`inserted_at` text NOT NULL,
	FOREIGN KEY (`raw_sha256`) REFERENCES `population_raw_objects`(`sha256`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `population_observation_identity` ON `population_observations` (`area_code`,`observed_at`,`raw_sha256`);--> statement-breakpoint
CREATE INDEX `population_observation_area_time` ON `population_observations` (`area_code`,`observed_at`);--> statement-breakpoint
CREATE TABLE `population_raw_objects` (
	`sha256` text PRIMARY KEY NOT NULL,
	`object_key` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`first_area_code` text NOT NULL,
	`http_status` integer NOT NULL,
	`source_url` text NOT NULL,
	`retrieved_at` text NOT NULL,
	CONSTRAINT "population_raw_size" CHECK("population_raw_objects"."size_bytes" BETWEEN 0 AND 1048576),
	CONSTRAINT "population_raw_http_status" CHECK("population_raw_objects"."http_status" BETWEEN 100 AND 599)
);
