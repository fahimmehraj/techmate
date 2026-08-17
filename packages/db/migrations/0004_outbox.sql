CREATE TYPE "outbox_status" AS ENUM ('pending', 'dispatched', 'failed');

CREATE TABLE "outbox_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "type" text NOT NULL,
  "aggregate_id" uuid NOT NULL,
  "expected_version" integer,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" "outbox_status" DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "dispatched_at" timestamptz,
  "last_error" text,
  "created_at" timestamptz DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "outbox_events_type_aggregate_version_unique" ON "outbox_events" ("type", "aggregate_id", "expected_version");
