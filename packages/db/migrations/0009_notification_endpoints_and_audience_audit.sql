CREATE TABLE notification_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  integration_id uuid REFERENCES organization_client_integrations(id) ON DELETE CASCADE,
  driver_id text NOT NULL,
  address text NOT NULL,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (driver_id IN ('discord.channel', 'discord.dm', 'email')),
  CHECK (status IN ('active', 'disabled'))
);
CREATE UNIQUE INDEX notification_endpoints_global_address_unique
  ON notification_endpoints(organization_id, driver_id, address) WHERE integration_id IS NULL;
CREATE UNIQUE INDEX notification_endpoints_integration_address_unique
  ON notification_endpoints(organization_id, integration_id, driver_id, address) WHERE integration_id IS NOT NULL;

CREATE TABLE person_notification_endpoint_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES organization_people(id) ON DELETE CASCADE,
  endpoint_id uuid NOT NULL REFERENCES notification_endpoints(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (purpose IN ('calendar_invite', 'direct_notification')),
  UNIQUE(person_id, endpoint_id, purpose)
);
CREATE UNIQUE INDEX person_notification_endpoint_one_calendar_invite
  ON person_notification_endpoint_bindings(person_id) WHERE purpose = 'calendar_invite';

ALTER TABLE meetings ADD COLUMN IF NOT EXISTS status_announcement_endpoint_id uuid REFERENCES notification_endpoints(id) ON DELETE SET NULL;
ALTER TABLE planning_sessions ADD COLUMN IF NOT EXISTS status_announcement_endpoint_id uuid REFERENCES notification_endpoints(id) ON DELETE SET NULL;
ALTER TABLE task_reminder_deliveries ADD COLUMN IF NOT EXISTS endpoint_id uuid REFERENCES notification_endpoints(id);

CREATE TABLE planning_audience_selections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  planning_session_id uuid NOT NULL REFERENCES planning_sessions(id) ON DELETE CASCADE,
  selected_by_person_id uuid NOT NULL REFERENCES organization_people(id),
  integration_id uuid REFERENCES organization_client_integrations(id) ON DELETE SET NULL,
  source jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE planning_audience_selection_people (
  selection_id uuid NOT NULL REFERENCES planning_audience_selections(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES organization_people(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (selection_id, person_id)
);

CREATE TABLE generic_person_migration_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE generic_person_migration_progress (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  run_id uuid REFERENCES generic_person_migration_runs(id) ON DELETE SET NULL,
  phase text NOT NULL,
  last_legacy_user_id uuid,
  last_legacy_member_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE generic_person_migration_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind text NOT NULL,
  legacy_user_id uuid,
  legacy_member_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX generic_person_migration_conflict_unique
  ON generic_person_migration_conflicts(organization_id, kind, legacy_user_id, legacy_member_id);

-- Manual, destructive cutovers are deliberately tracked outside the automatic
-- migration ledger so a normal deployment can never replay one.
CREATE TABLE manual_schema_migrations (
  name text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
