CREATE TABLE `active_models` (
	`name` text PRIMARY KEY NOT NULL,
	`generation` integer NOT NULL,
	`model_version` text NOT NULL,
	FOREIGN KEY (`name`,`generation`,`model_version`) REFERENCES `model_activations`(`name`,`generation`,`model_version`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `data_releases` (
	`id` text PRIMARY KEY NOT NULL,
	`manifest_object_key` text NOT NULL,
	`manifest_sha256` text NOT NULL,
	`available_cutoff` text NOT NULL,
	`sealed_at` text NOT NULL,
	CONSTRAINT "release_cutoff" CHECK("data_releases"."available_cutoff" <= "data_releases"."sealed_at")
);
--> statement-breakpoint
CREATE TABLE `dataset_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`data_release_id` text NOT NULL,
	`object_key` text NOT NULL,
	`sha256` text NOT NULL,
	`feature_version` text NOT NULL,
	`target_version` text NOT NULL,
	`split_policy_json` text NOT NULL,
	`row_count` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`data_release_id`) REFERENCES `data_releases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_version`) REFERENCES `target_definitions`(`version`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "dataset_rows" CHECK("dataset_snapshots"."row_count" > 0),
	CONSTRAINT "dataset_split" CHECK(json_valid("dataset_snapshots"."split_policy_json"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dataset_identity_versions` ON `dataset_snapshots` (`id`,`feature_version`,`target_version`);--> statement-breakpoint
CREATE TABLE `derivation_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`input_version` text NOT NULL,
	`publication_sequence` integer,
	`model_version` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`cursor_entity` text DEFAULT '' NOT NULL,
	`cursor_time` text DEFAULT '' NOT NULL,
	`processed_rows` integer DEFAULT 0 NOT NULL,
	`lease_token` text,
	`lease_until` text,
	`error_code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`publication_sequence`) REFERENCES `observation_publications`(`sequence`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`model_version`) REFERENCES `model_artifacts`(`version`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "derivation_status" CHECK("derivation_jobs"."status" IN ('pending','running','succeeded','failed')),
	CONSTRAINT "derivation_attempts" CHECK("derivation_jobs"."attempt_count" >= 0),
	CONSTRAINT "derivation_lease" CHECK(("derivation_jobs"."status" = 'running' AND "derivation_jobs"."lease_token" IS NOT NULL AND "derivation_jobs"."lease_until" IS NOT NULL) OR ("derivation_jobs"."status" <> 'running' AND "derivation_jobs"."lease_token" IS NULL AND "derivation_jobs"."lease_until" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `derivation_input` ON `derivation_jobs` (`kind`,`input_version`);--> statement-breakpoint
CREATE INDEX `derivation_pending` ON `derivation_jobs` (`status`,`lease_until`);--> statement-breakpoint
CREATE TABLE `feature_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_id` text NOT NULL,
	`as_of` text NOT NULL,
	`available_cutoff` text NOT NULL,
	`feature_version` text NOT NULL,
	`data_release_id` text NOT NULL,
	`observation_revision_id` text NOT NULL,
	`location_revision_id` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`data_release_id`) REFERENCES `data_releases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`observation_revision_id`) REFERENCES `observation_revisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`location_revision_id`) REFERENCES `observation_revisions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "feature_payload" CHECK(json_valid("feature_snapshots"."payload_json")),
	CONSTRAINT "feature_asof" CHECK("feature_snapshots"."as_of" <= "feature_snapshots"."available_cutoff")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feature_grain` ON `feature_snapshots` (`entity_id`,`as_of`,`feature_version`,`data_release_id`,`available_cutoff`);--> statement-breakpoint
CREATE UNIQUE INDEX `feature_identity_version` ON `feature_snapshots` (`id`,`feature_version`);--> statement-breakpoint
CREATE INDEX `feature_observation` ON `feature_snapshots` (`observation_revision_id`);--> statement-breakpoint
CREATE INDEX `feature_location` ON `feature_snapshots` (`location_revision_id`);--> statement-breakpoint
CREATE TABLE `model_activations` (
	`name` text NOT NULL,
	`generation` integer NOT NULL,
	`model_version` text NOT NULL,
	`previous_version` text,
	`reason` text NOT NULL,
	`activated_by` text NOT NULL,
	`activated_at` text NOT NULL,
	PRIMARY KEY(`name`, `generation`),
	FOREIGN KEY (`model_version`) REFERENCES `model_artifacts`(`version`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`previous_version`) REFERENCES `model_artifacts`(`version`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "activation_generation" CHECK("model_activations"."generation" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activation_identity_model` ON `model_activations` (`name`,`generation`,`model_version`);--> statement-breakpoint
CREATE TABLE `model_artifacts` (
	`version` text PRIMARY KEY NOT NULL,
	`training_run_id` text,
	`origin` text DEFAULT 'trained' NOT NULL,
	`feature_version` text NOT NULL,
	`target_version` text NOT NULL,
	`object_key` text NOT NULL,
	`digest` text NOT NULL,
	`manifest_json` text NOT NULL,
	`approval_status` text DEFAULT 'candidate' NOT NULL,
	`approved_by` text,
	`approved_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`training_run_id`,`feature_version`,`target_version`) REFERENCES `training_runs`(`id`,`feature_version`,`target_version`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "model_manifest" CHECK(json_valid("model_artifacts"."manifest_json")),
	CONSTRAINT "model_approval_status" CHECK("model_artifacts"."approval_status" IN ('candidate','approved','rejected')),
	CONSTRAINT "model_approval_record" CHECK("model_artifacts"."approval_status" <> 'approved' OR ("model_artifacts"."approved_by" IS NOT NULL AND "model_artifacts"."approved_at" IS NOT NULL)),
	CONSTRAINT "model_origin" CHECK(("model_artifacts"."origin" = 'trained' AND "model_artifacts"."training_run_id" IS NOT NULL) OR ("model_artifacts"."origin" = 'bundled' AND "model_artifacts"."training_run_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_identity_feature` ON `model_artifacts` (`version`,`feature_version`);--> statement-breakpoint
CREATE TABLE `observation_publications` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text,
	`origin` text DEFAULT 'collection' NOT NULL,
	`available_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `collection_jobs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "publication_origin" CHECK(("observation_publications"."origin" = 'collection' AND "observation_publications"."job_id" IS NOT NULL) OR ("observation_publications"."origin" = 'baseline' AND "observation_publications"."job_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publication_job` ON `observation_publications` (`job_id`);--> statement-breakpoint
CREATE INDEX `publication_available` ON `observation_publications` (`available_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `publication_baseline` ON `observation_publications` (`origin`) WHERE "observation_publications"."origin" = 'baseline';--> statement-breakpoint
CREATE TABLE `observation_selections` (
	`publication_sequence` integer NOT NULL,
	`source` text NOT NULL,
	`entity_id` text NOT NULL,
	`observed_at` text NOT NULL,
	`revision_id` text NOT NULL,
	PRIMARY KEY(`publication_sequence`, `source`, `entity_id`, `observed_at`),
	FOREIGN KEY (`publication_sequence`) REFERENCES `observation_publications`(`sequence`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`revision_id`) REFERENCES `observation_revisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `selection_asof` ON `observation_selections` (`source`,`entity_id`,`observed_at`,`publication_sequence`);--> statement-breakpoint
CREATE TABLE `point_assessments` (
	`id` text PRIMARY KEY NOT NULL,
	`lat` real NOT NULL,
	`lon` real NOT NULL,
	`as_of` text NOT NULL,
	`data_release_id` text NOT NULL,
	`policy_version` text NOT NULL,
	`score` real,
	`status` text NOT NULL,
	`reason_code` text,
	`computed_at` text NOT NULL,
	FOREIGN KEY (`data_release_id`) REFERENCES `data_releases`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "point_coordinates" CHECK("point_assessments"."lat" BETWEEN -90 AND 90 AND "point_assessments"."lon" BETWEEN -180 AND 180),
	CONSTRAINT "point_status_score" CHECK(("point_assessments"."status" = 'scored' AND "point_assessments"."score" IS NOT NULL AND "point_assessments"."score" BETWEEN 0 AND 100) OR ("point_assessments"."status" = 'unsupported' AND "point_assessments"."score" IS NULL AND "point_assessments"."reason_code" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `point_contributors` (
	`assessment_id` text NOT NULL,
	`prediction_id` text NOT NULL,
	`distance_m` real NOT NULL,
	`weight` real NOT NULL,
	PRIMARY KEY(`assessment_id`, `prediction_id`),
	FOREIGN KEY (`assessment_id`) REFERENCES `point_assessments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`prediction_id`) REFERENCES `prediction_results`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "contributor_distance_weight" CHECK("point_contributors"."distance_m" >= 0 AND "point_contributors"."weight" > 0 AND "point_contributors"."weight" <= 1)
);
--> statement-breakpoint
CREATE TABLE `population_request_leases` (
	`area_code` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`lease_until` text NOT NULL,
	`next_allowed_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `prediction_results` (
	`id` text PRIMARY KEY NOT NULL,
	`feature_snapshot_id` text NOT NULL,
	`feature_version` text NOT NULL,
	`model_version` text NOT NULL,
	`policy_version` text NOT NULL,
	`score` real,
	`status` text NOT NULL,
	`reason_code` text,
	`computed_at` text NOT NULL,
	FOREIGN KEY (`feature_snapshot_id`,`feature_version`) REFERENCES `feature_snapshots`(`id`,`feature_version`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`model_version`,`feature_version`) REFERENCES `model_artifacts`(`version`,`feature_version`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "prediction_status_score" CHECK(("prediction_results"."status" = 'scored' AND "prediction_results"."score" IS NOT NULL AND "prediction_results"."score" BETWEEN 0 AND 100) OR ("prediction_results"."status" = 'unsupported' AND "prediction_results"."score" IS NULL AND "prediction_results"."reason_code" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prediction_input_model_policy` ON `prediction_results` (`feature_snapshot_id`,`model_version`,`policy_version`);--> statement-breakpoint
CREATE TABLE `target_definitions` (
	`version` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`description` text NOT NULL,
	`definition_object_key` text NOT NULL,
	`definition_sha256` text NOT NULL,
	`horizon_seconds` integer,
	`created_at` text NOT NULL,
	CONSTRAINT "target_kind_horizon" CHECK(("target_definitions"."kind" = 'rule_index' AND "target_definitions"."horizon_seconds" IS NULL) OR ("target_definitions"."kind" = 'future_observation' AND "target_definitions"."horizon_seconds" > 0 AND "target_definitions"."horizon_seconds" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `target_values` (
	`id` text PRIMARY KEY NOT NULL,
	`feature_snapshot_id` text NOT NULL,
	`target_version` text NOT NULL,
	`value` real NOT NULL,
	`target_time` text NOT NULL,
	`available_at` text NOT NULL,
	`object_key` text NOT NULL,
	`sha256` text NOT NULL,
	FOREIGN KEY (`feature_snapshot_id`) REFERENCES `feature_snapshots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_version`) REFERENCES `target_definitions`(`version`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "target_value_range" CHECK("target_values"."value" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `target_feature_version` ON `target_values` (`feature_snapshot_id`,`target_version`);--> statement-breakpoint
CREATE TABLE `training_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`dataset_id` text NOT NULL,
	`feature_version` text NOT NULL,
	`target_version` text NOT NULL,
	`code_sha` text NOT NULL,
	`seed` integer NOT NULL,
	`status` text NOT NULL,
	`parameters_json` text NOT NULL,
	`metrics_json` text,
	`baseline_metrics_json` text,
	`evaluation_policy_version` text NOT NULL,
	`error_code` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`dataset_id`,`feature_version`,`target_version`) REFERENCES `dataset_snapshots`(`id`,`feature_version`,`target_version`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "training_status" CHECK("training_runs"."status" IN ('running','succeeded','failed')),
	CONSTRAINT "training_parameters" CHECK(json_valid("training_runs"."parameters_json")),
	CONSTRAINT "training_metrics" CHECK("training_runs"."metrics_json" IS NULL OR json_valid("training_runs"."metrics_json")),
	CONSTRAINT "training_baselines" CHECK("training_runs"."baseline_metrics_json" IS NULL OR json_valid("training_runs"."baseline_metrics_json")),
	CONSTRAINT "training_success" CHECK("training_runs"."status" <> 'succeeded' OR ("training_runs"."metrics_json" IS NOT NULL AND "training_runs"."baseline_metrics_json" IS NOT NULL AND "training_runs"."finished_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `training_identity_versions` ON `training_runs` (`id`,`feature_version`,`target_version`);--> statement-breakpoint
CREATE UNIQUE INDEX `training_active_dataset` ON `training_runs` (`dataset_id`) WHERE "training_runs"."status" = 'running';