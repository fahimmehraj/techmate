CREATE TABLE "web_launches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "web_integration_id" uuid NOT NULL REFERENCES "organization_client_integrations"("id") ON DELETE CASCADE,
  "person_id" uuid NOT NULL REFERENCES "organization_people"("id") ON DELETE CASCADE,
  "operation" text NOT NULL,
  "token_hash" text NOT NULL UNIQUE,
  "expires_at" timestamptz NOT NULL,
  "redeemed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE TABLE "web_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "web_integration_id" uuid NOT NULL REFERENCES "organization_client_integrations"("id") ON DELETE CASCADE,
  "person_id" uuid NOT NULL REFERENCES "organization_people"("id") ON DELETE CASCADE,
  "operation" text NOT NULL,
  "token_hash" text NOT NULL UNIQUE,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
