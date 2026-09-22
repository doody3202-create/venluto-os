CREATE TABLE `campaigns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`provider` text DEFAULT 'smartlead' NOT NULL,
	`external_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_campaign_provider_external` ON `campaigns` (`provider`,`external_id`);--> statement-breakpoint
CREATE TABLE `companies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`domain` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `companies_domain_unique` ON `companies` (`domain`);--> statement-breakpoint
CREATE TABLE `external_refs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_external_ref_identity` ON `external_refs` (`provider`,`entity_type`,`external_id`);--> statement-breakpoint
CREATE TABLE `integration_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`external_event_id` text NOT NULL,
	`event_type` text NOT NULL,
	`payload_json` text NOT NULL,
	`processed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_events_provider_external` ON `integration_events` (`provider`,`external_event_id`);--> statement-breakpoint
CREATE TABLE `meetings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`prospect_id` integer,
	`booking_uid` text NOT NULL,
	`title` text NOT NULL,
	`starts_at` text NOT NULL,
	`ends_at` text,
	`status` text NOT NULL,
	`attendee_email` text NOT NULL,
	`booking_url` text,
	FOREIGN KEY (`prospect_id`) REFERENCES `prospects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `meetings_booking_uid_unique` ON `meetings` (`booking_uid`);--> statement-breakpoint
CREATE TABLE `owners` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`initials` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `owners_email_unique` ON `owners` (`email`);--> statement-breakpoint
CREATE TABLE `prospect_transitions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`prospect_id` integer NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`prospect_id`) REFERENCES `prospects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `prospects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`first_name` text NOT NULL,
	`last_name` text DEFAULT '' NOT NULL,
	`email` text NOT NULL,
	`normalized_email` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`owner_id` integer,
	`company_id` integer,
	`next_action` text,
	`deadline_at` text,
	`close_url` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_prospects_normalized_email` ON `prospects` (`normalized_email`);--> statement-breakpoint
CREATE TABLE `replies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`prospect_id` integer NOT NULL,
	`campaign_id` integer,
	`provider_reply_id` text NOT NULL,
	`body` text NOT NULL,
	`sentiment` text DEFAULT 'positive' NOT NULL,
	`received_at` text NOT NULL,
	FOREIGN KEY (`prospect_id`) REFERENCES `prospects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `replies_provider_reply_id_unique` ON `replies` (`provider_reply_id`);--> statement-breakpoint
CREATE TABLE `sync_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`operation` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`next_retry_at` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_jobs_idempotency_key_unique` ON `sync_jobs` (`idempotency_key`);