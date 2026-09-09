CREATE TABLE `glossary` (
	`term` text PRIMARY KEY NOT NULL,
	`brief` text NOT NULL,
	`topic_id` integer
);
--> statement-breakpoint
CREATE INDEX `idx_glossary_topic` ON `glossary` (`topic_id`);--> statement-breakpoint
CREATE TABLE `question_explanations` (
	`content_key` text PRIMARY KEY NOT NULL,
	`correct_reason` text NOT NULL,
	`choices_json` text NOT NULL,
	`updated_at` text
);
