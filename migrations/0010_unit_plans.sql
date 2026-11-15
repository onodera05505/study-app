CREATE TABLE `topic_prerequisites` (
	`topic_id` integer NOT NULL,
	`prerequisite_topic_id` integer NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`topic_id`, `prerequisite_topic_id`),
	FOREIGN KEY (`topic_id`) REFERENCES `topics`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`prerequisite_topic_id`) REFERENCES `topics`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_topic_prerequisites_position_positive" CHECK("topic_prerequisites"."position" >= 1),
	CONSTRAINT "ck_topic_prerequisites_not_self" CHECK("topic_prerequisites"."topic_id" <> "topic_prerequisites"."prerequisite_topic_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_topic_prerequisites_position` ON `topic_prerequisites` (`topic_id`,`position`);--> statement-breakpoint
CREATE TABLE `unit_group_topics` (
	`topic_id` integer PRIMARY KEY NOT NULL,
	`middle_no` integer NOT NULL,
	`group_no` integer NOT NULL,
	`position` integer NOT NULL,
	FOREIGN KEY (`topic_id`) REFERENCES `topics`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`middle_no`,`group_no`) REFERENCES `unit_groups`(`middle_no`,`group_no`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_unit_group_topics_position_positive" CHECK("unit_group_topics"."position" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_unit_group_topics_position` ON `unit_group_topics` (`middle_no`,`group_no`,`position`);--> statement-breakpoint
CREATE TABLE `unit_groups` (
	`middle_no` integer NOT NULL,
	`group_no` integer NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	PRIMARY KEY(`middle_no`, `group_no`),
	FOREIGN KEY (`middle_no`) REFERENCES `unit_plans`(`middle_no`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_unit_groups_group_no_positive" CHECK("unit_groups"."group_no" >= 1),
	CONSTRAINT "ck_unit_groups_name_not_empty" CHECK("unit_groups"."name" <> ''),
	CONSTRAINT "ck_unit_groups_description_not_empty" CHECK("unit_groups"."description" <> '')
);
--> statement-breakpoint
CREATE TABLE `unit_plans` (
	`middle_no` integer PRIMARY KEY NOT NULL,
	`overview` text NOT NULL,
	CONSTRAINT "ck_unit_plans_overview_not_empty" CHECK("unit_plans"."overview" <> '')
);
