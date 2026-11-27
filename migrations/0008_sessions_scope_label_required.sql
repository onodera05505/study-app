-- @implements BR-040
-- sessions.scope_label を NULL も空の文字列も許さない列にする。SQLite は列の制約を後から変えられないので表を作り直す。
-- D1 は PRAGMA foreign_keys=OFF を受け付けず、親の表の DROP は ON DELETE CASCADE で session_questions の行を消す。
-- そのため session_questions の行を退避してから作り直し、作り直した後に戻す（外部キーの検査は表を戻すまで遅らせる）。
-- 範囲の名前が NULL・空の行が既にあれば INSERT が制約で落ち、このマイグレーションは当たらない（値を作って埋めない）。
PRAGMA defer_foreign_keys = on;--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`source_exam` text,
	`scope_label` text NOT NULL,
	`time_limit_sec` integer,
	`question_count` integer NOT NULL,
	`correct_count` integer,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_sessions_scope_label_not_empty" CHECK(`scope_label` <> '')
);
--> statement-breakpoint
INSERT INTO `__new_sessions`("id", "user_id", "kind", "status", "source_exam", "scope_label", "time_limit_sec", "question_count", "correct_count", "started_at", "finished_at") SELECT "id", "user_id", "kind", "status", "source_exam", "scope_label", "time_limit_sec", "question_count", "correct_count", "started_at", "finished_at" FROM `sessions`;--> statement-breakpoint
CREATE TABLE `__keep_session_questions` AS SELECT * FROM `session_questions`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
DELETE FROM `session_questions`;--> statement-breakpoint
INSERT INTO `session_questions`("id", "session_id", "question_id", "idx", "snapshot", "user_answer", "result", "answered_at") SELECT "id", "session_id", "question_id", "idx", "snapshot", "user_answer", "result", "answered_at" FROM `__keep_session_questions`;--> statement-breakpoint
DROP TABLE `__keep_session_questions`;--> statement-breakpoint
CREATE INDEX `idx_session_user_status` ON `sessions` (`user_id`,`status`,`started_at`);
