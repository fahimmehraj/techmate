CREATE TYPE provider_installation_status AS ENUM ('configuring','enabled','disabled');
CREATE TYPE room_booking_status AS ENUM ('discovering','awaiting_confirmation','submitting','request_submitted','failed');
CREATE TABLE provider_installations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider_id text NOT NULL,
  status provider_installation_status NOT NULL DEFAULT 'configuring',
  values jsonb NOT NULL DEFAULT '{}'::jsonb,
  configured_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, provider_id)
);
CREATE TABLE room_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  provider_installation_id uuid NOT NULL REFERENCES provider_installations(id),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  status room_booking_status NOT NULL DEFAULT 'discovering',
  room jsonb,
  provider_reference text,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX room_bookings_meeting_idx ON room_bookings(meeting_id);
