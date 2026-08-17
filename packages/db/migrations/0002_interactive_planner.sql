CREATE TYPE planning_session_status AS ENUM ('collecting_audience', 'waiting_for_requirements', 'ready', 'confirmed', 'expired');
CREATE TYPE planning_session_kind AS ENUM ('create', 'reschedule');
CREATE TYPE planning_attendee_readiness AS ENUM ('ready', 'needs_invite_email', 'needs_availability', 'unverified');

CREATE TABLE client_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client text NOT NULL,
  subject_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, client, subject_id)
);
INSERT INTO client_identities (user_id, client, subject_id)
SELECT id, 'discord', discord_user_id FROM users;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_org_discord_unique;
ALTER TABLE users DROP COLUMN discord_user_id;

ALTER TABLE capability_grants ADD COLUMN subject_client text;
UPDATE capability_grants
SET subject_kind = 'client_group', subject_client = 'discord'
WHERE subject_kind = 'discord_role';
DROP INDEX IF EXISTS capability_grants_unique;
CREATE UNIQUE INDEX capability_grants_unique ON capability_grants(organization_id, capability, subject_kind, subject_client, subject_id);

ALTER TABLE meetings ADD COLUMN notification_client text NOT NULL DEFAULT 'discord';
ALTER TABLE meetings ADD COLUMN notification_channel_id text;
UPDATE meetings SET notification_channel_id = discord_channel_id;
ALTER TABLE meetings ALTER COLUMN notification_channel_id SET NOT NULL;
ALTER TABLE meetings DROP COLUMN discord_channel_id;

ALTER TABLE meeting_participants RENAME TO meeting_participants_legacy;
CREATE TABLE meeting_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  member_id uuid REFERENCES members(id),
  kind text NOT NULL DEFAULT 'registered_member',
  display_name_snapshot text NOT NULL,
  calendar_invite_email_snapshot text NOT NULL,
  attendance_role text NOT NULL DEFAULT 'required',
  UNIQUE(meeting_id, calendar_invite_email_snapshot)
);
INSERT INTO meeting_participants (meeting_id, member_id, kind, display_name_snapshot, calendar_invite_email_snapshot, attendance_role)
SELECT meeting_id, member_id, 'registered_member', display_name_snapshot, calendar_invite_email_snapshot, attendance_role
FROM meeting_participants_legacy;
DROP TABLE meeting_participants_legacy;

DROP TABLE IF EXISTS team_members;
DROP TABLE IF EXISTS teams;

CREATE TABLE planning_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  kind planning_session_kind NOT NULL,
  source_meeting_id uuid REFERENCES meetings(id) ON DELETE CASCADE,
  notification_client text NOT NULL DEFAULT 'discord',
  notification_channel_id text NOT NULL,
  status planning_session_status NOT NULL DEFAULT 'collecting_audience',
  title text,
  selected_starts_at timestamptz,
  selected_ends_at timestamptz,
  availability_override integer NOT NULL DEFAULT 0,
  guest_emails jsonb NOT NULL DEFAULT '[]'::jsonb,
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE planning_attendees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  planning_session_id uuid NOT NULL REFERENCES planning_sessions(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  display_name text NOT NULL,
  source jsonb NOT NULL,
  readiness planning_attendee_readiness NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(planning_session_id, user_id)
);
CREATE TABLE planning_launch_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  planning_session_id uuid NOT NULL REFERENCES planning_sessions(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz
);
CREATE TABLE planning_browser_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  planning_session_id uuid NOT NULL REFERENCES planning_sessions(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
