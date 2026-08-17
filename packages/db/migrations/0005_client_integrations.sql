CREATE TABLE "organization_client_integrations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE TABLE "discord_integration_configs" (
  "integration_id" uuid PRIMARY KEY REFERENCES "organization_client_integrations"("id") ON DELETE CASCADE,
  "guild_id" text NOT NULL UNIQUE
);
CREATE TABLE "web_integration_configs" (
  "integration_id" uuid PRIMARY KEY REFERENCES "organization_client_integrations"("id") ON DELETE CASCADE,
  "slug" text NOT NULL UNIQUE
);
CREATE TABLE "organization_people" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "display_name" text NOT NULL,
  "invitation_email" text,
  "status" text DEFAULT 'active' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "organization_people_invitation_email_unique" ON "organization_people" ("organization_id", "invitation_email");
CREATE TABLE "organization_owners" (
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "person_id" uuid NOT NULL REFERENCES "organization_people"("id") ON DELETE CASCADE,
  "granted_by_person_id" uuid REFERENCES "organization_people"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  PRIMARY KEY ("organization_id", "person_id")
);
CREATE TABLE "integration_identities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "integration_id" uuid NOT NULL REFERENCES "organization_client_integrations"("id") ON DELETE CASCADE,
  "person_id" uuid NOT NULL REFERENCES "organization_people"("id") ON DELETE CASCADE,
  "external_subject_id" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "integration_identities_subject_unique" ON "integration_identities" ("integration_id", "external_subject_id");
