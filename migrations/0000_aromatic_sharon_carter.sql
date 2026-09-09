CREATE TABLE `app_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`drill_size` integer DEFAULT 10 NOT NULL,
	`mock_size` integer DEFAULT 100 NOT NULL,
	`mock_time_limit_sec` integer DEFAULT 7200 NOT NULL,
	`pass_overall_pct` integer DEFAULT 60 NOT NULL,
	`pass_field_pct` integer DEFAULT 30 NOT NULL,
	`mastered_streak` integer DEFAULT 3 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `past_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`exam` text NOT NULL,
	`exam_label` text NOT NULL,
	`number` integer NOT NULL,
	`text` text NOT NULL,
	`choices` text NOT NULL,
	`answer` text NOT NULL,
	`has_figure` integer DEFAULT false NOT NULL,
	`figure_description` text,
	`citation` text NOT NULL,
	`modified` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_question_exam_number` ON `past_questions` (`exam`,`number`);--> statement-breakpoint
CREATE INDEX `idx_question_exam` ON `past_questions` (`exam`,`number`);--> statement-breakpoint
CREATE TABLE `progress` (
	`user_id` text NOT NULL,
	`topic_id` integer NOT NULL,
	`status` integer DEFAULT 1 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`user_id`, `topic_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`topic_id`) REFERENCES `topics`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `session_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`question_id` text NOT NULL,
	`idx` integer NOT NULL,
	`snapshot` text NOT NULL,
	`user_answer` text,
	`result` integer DEFAULT 0 NOT NULL,
	`answered_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`question_id`) REFERENCES `past_questions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_sq_session_idx` ON `session_questions` (`session_id`,`idx`);--> statement-breakpoint
CREATE INDEX `idx_sq_progress` ON `session_questions` (`session_id`,`result`,`idx`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`source_exam` text,
	`scope_label` text,
	`time_limit_sec` integer,
	`question_count` integer NOT NULL,
	`correct_count` integer,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_session_user_status` ON `sessions` (`user_id`,`status`,`started_at`);--> statement-breakpoint
CREATE TABLE `syllabus_items` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`field` text NOT NULL,
	`major_no` integer NOT NULL,
	`major` text NOT NULL,
	`middle_no` integer NOT NULL,
	`middle` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_syllabus_field` ON `syllabus_items` (`field`,`id`);--> statement-breakpoint
CREATE TABLE `topic_questions` (
	`topic_id` integer NOT NULL,
	`question_id` text NOT NULL,
	`is_primary` integer DEFAULT true NOT NULL,
	PRIMARY KEY(`topic_id`, `question_id`),
	FOREIGN KEY (`topic_id`) REFERENCES `topics`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`question_id`) REFERENCES `past_questions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_tq_question` ON `topic_questions` (`question_id`);--> statement-breakpoint
CREATE TABLE `topics` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`term` text NOT NULL,
	`syllabus_item_id` integer NOT NULL,
	`is_new` integer DEFAULT false NOT NULL,
	`explanation` text,
	`detail` text,
	`question_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`syllabus_item_id`) REFERENCES `syllabus_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_topic_term` ON `topics` (`syllabus_item_id`,`term`);--> statement-breakpoint
CREATE INDEX `idx_topic_freq` ON `topics` (`question_count`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'MEMBER' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_user_email` ON `users` (`email`);