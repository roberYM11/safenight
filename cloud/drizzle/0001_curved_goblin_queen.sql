CREATE TABLE `latest_observations` (
	`source` text NOT NULL,
	`entity_id` text NOT NULL,
	`observed_at` text NOT NULL,
	`revision_id` text NOT NULL,
	PRIMARY KEY(`source`, `entity_id`),
	FOREIGN KEY (`revision_id`) REFERENCES `observation_revisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `revision_job` ON `observation_revisions` (`first_job_id`);