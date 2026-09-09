ALTER TABLE `past_questions` ADD `content_key` text;--> statement-breakpoint
CREATE INDEX `idx_question_content` ON `past_questions` (`content_key`);