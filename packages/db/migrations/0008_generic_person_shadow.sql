-- Additive compatibility columns. Legacy values remain authoritative until the
-- resumable backfill and reviewed cutover have both completed.
ALTER TABLE users ADD COLUMN IF NOT EXISTS person_id uuid REFERENCES organization_people(id);
ALTER TABLE members ADD COLUMN IF NOT EXISTS person_id uuid REFERENCES organization_people(id);

ALTER TABLE calendar_connections ADD COLUMN IF NOT EXISTS person_id uuid REFERENCES organization_people(id) ON DELETE CASCADE;
ALTER TABLE calendar_connections ADD COLUMN IF NOT EXISTS authorized_by_person_id uuid REFERENCES organization_people(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS calendar_connections_one_availability_per_person
  ON calendar_connections(person_id) WHERE kind = 'availability';

ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS person_id uuid REFERENCES organization_people(id) ON DELETE CASCADE;

ALTER TABLE meetings ADD COLUMN IF NOT EXISTS created_by_person_id uuid REFERENCES organization_people(id);
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS initiated_via_integration_id uuid REFERENCES organization_client_integrations(id);
ALTER TABLE meeting_participants ADD COLUMN IF NOT EXISTS person_id uuid REFERENCES organization_people(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS meeting_participants_meeting_person_unique
  ON meeting_participants(meeting_id, person_id) WHERE person_id IS NOT NULL;

ALTER TABLE planning_sessions ADD COLUMN IF NOT EXISTS created_by_person_id uuid REFERENCES organization_people(id);
ALTER TABLE planning_sessions ADD COLUMN IF NOT EXISTS initiated_via_integration_id uuid REFERENCES organization_client_integrations(id);
ALTER TABLE planning_attendees ADD COLUMN IF NOT EXISTS person_id uuid REFERENCES organization_people(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS planning_attendees_session_person_unique
  ON planning_attendees(planning_session_id, person_id) WHERE person_id IS NOT NULL;

ALTER TABLE provider_installations ADD COLUMN IF NOT EXISTS configured_by_person_id uuid REFERENCES organization_people(id);
ALTER TABLE room_bookings ADD COLUMN IF NOT EXISTS created_by_person_id uuid REFERENCES organization_people(id);
