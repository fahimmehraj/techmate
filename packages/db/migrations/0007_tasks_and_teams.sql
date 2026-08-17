CREATE TYPE "task_status" AS ENUM ('draft', 'open', 'completed', 'cancelled');
CREATE TYPE "task_assignment_status" AS ENUM ('open', 'completed');
CREATE TYPE "task_reminder_policy" AS ENUM ('daily_until_done', 'one_day_before', 'one_hour_before', 'none');
CREATE TYPE "task_reminder_delivery_status" AS ENUM ('sent', 'failed', 'skipped');

CREATE TABLE "teams" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "created_by_person_id" uuid NOT NULL REFERENCES "organization_people"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "teams_organization_name_unique" ON "teams" ("organization_id", "name");

CREATE TABLE "team_members" (
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "person_id" uuid NOT NULL REFERENCES "organization_people"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("team_id", "person_id")
);

CREATE TABLE "tasks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "created_by_person_id" uuid NOT NULL REFERENCES "organization_people"("id"),
  "source_integration_id" uuid NOT NULL REFERENCES "organization_client_integrations"("id"),
  "title" text NOT NULL,
  "description" text,
  "due_at" timestamp with time zone,
  "time_zone" text NOT NULL,
  "status" "task_status" DEFAULT 'draft' NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "task_assignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "task_id" uuid NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  "person_id" uuid NOT NULL REFERENCES "organization_people"("id") ON DELETE CASCADE,
  "status" "task_assignment_status" DEFAULT 'open' NOT NULL,
  "reminder_policy_override" "task_reminder_policy",
  "reminder_revision" integer DEFAULT 1 NOT NULL,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "task_assignments_task_person_unique" ON "task_assignments" ("task_id", "person_id");

CREATE TABLE "person_task_reminder_preferences" (
  "person_id" uuid PRIMARY KEY NOT NULL REFERENCES "organization_people"("id") ON DELETE CASCADE,
  "default_policy" "task_reminder_policy" DEFAULT 'daily_until_done' NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "task_reminder_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "assignment_id" uuid NOT NULL REFERENCES "task_assignments"("id") ON DELETE CASCADE,
  "integration_id" uuid NOT NULL REFERENCES "organization_client_integrations"("id"),
  "reminder_revision" integer NOT NULL,
  "scheduled_for" timestamp with time zone NOT NULL,
  "status" "task_reminder_delivery_status" NOT NULL,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "task_reminder_deliveries_assignment_revision_occurrence_unique" ON "task_reminder_deliveries" ("assignment_id", "reminder_revision", "scheduled_for");
