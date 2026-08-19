import { sql } from "drizzle-orm";
import { integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const meetingStatus = pgEnum("meeting_status", [
  "draft", "discovering", "awaiting_confirmation", "calendar_pending", "scheduled", "calendar_failed", "cancelled",
]);
export const connectionKind = pgEnum("calendar_connection_kind", ["organizer", "availability"]);
export const connectionStatus = pgEnum("connection_status", ["active", "revoked", "expired"]);
export const jobStatus = pgEnum("job_status", ["ready", "leased", "succeeded", "failed", "dead"]);
export const outboxStatus = pgEnum("outbox_status", ["pending", "dispatched", "failed"]);
export const providerInstallationStatus = pgEnum("provider_installation_status", ["configuring", "enabled", "disabled"]);
export const roomBookingStatus = pgEnum("room_booking_status", ["discovering", "awaiting_confirmation", "submitting", "request_submitted", "failed"]);
export const planningSessionStatus = pgEnum("planning_session_status", ["collecting_audience", "waiting_for_requirements", "ready", "confirmed", "expired"]);
export const planningSessionKind = pgEnum("planning_session_kind", ["create", "reschedule"]);
export const planningAttendeeReadiness = pgEnum("planning_attendee_readiness", ["ready", "needs_invite_email", "needs_availability", "unverified"]);
export const taskStatus = pgEnum("task_status", ["draft", "open", "completed", "cancelled"]);
export const taskAssignmentStatus = pgEnum("task_assignment_status", ["open", "completed"]);
export const taskReminderPolicy = pgEnum("task_reminder_policy", ["daily_until_done", "one_day_before", "one_hour_before", "none"]);
export const taskReminderDeliveryStatus = pgEnum("task_reminder_delivery_status", ["sent", "failed", "skipped"]);

export const organizations = pgTable("organizations", {
  id: uuid("id").defaultRandom().primaryKey(),
  discordGuildId: text("discord_guild_id").notNull().unique(),
  name: text("name").notNull(),
  timeZone: text("time_zone").notNull().default("America/New_York"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Client-neutral identity boundary. New code should use these tables rather
 * than reaching through a Discord guild or a split user/member pair. */
export const organizationClientIntegrations = pgTable("organization_client_integrations", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const discordIntegrationConfigs = pgTable("discord_integration_configs", {
  integrationId: uuid("integration_id").primaryKey().references(() => organizationClientIntegrations.id, { onDelete: "cascade" }),
  guildId: text("guild_id").notNull().unique(),
});

export const webIntegrationConfigs = pgTable("web_integration_configs", {
  integrationId: uuid("integration_id").primaryKey().references(() => organizationClientIntegrations.id, { onDelete: "cascade" }),
  slug: text("slug").notNull().unique(),
});

export const organizationPeople = pgTable("organization_people", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  displayName: text("display_name").notNull(),
  invitationEmail: text("invitation_email"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("organization_people_invitation_email_unique").on(table.organizationId, table.invitationEmail)]);

/** Saved teams are organization-owned, static person snapshots. */
export const teams = pgTable("teams", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  createdByPersonId: uuid("created_by_person_id").notNull().references(() => organizationPeople.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("teams_organization_name_unique").on(table.organizationId, table.name)]);

export const teamMembers = pgTable("team_members", {
  teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  personId: uuid("person_id").notNull().references(() => organizationPeople.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.teamId, table.personId] })]);

export const organizationOwners = pgTable("organization_owners", {
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  personId: uuid("person_id").notNull().references(() => organizationPeople.id, { onDelete: "cascade" }),
  grantedByPersonId: uuid("granted_by_person_id").references(() => organizationPeople.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.organizationId, table.personId] })]);

export const integrationIdentities = pgTable("integration_identities", {
  id: uuid("id").defaultRandom().primaryKey(),
  integrationId: uuid("integration_id").notNull().references(() => organizationClientIntegrations.id, { onDelete: "cascade" }),
  personId: uuid("person_id").notNull().references(() => organizationPeople.id, { onDelete: "cascade" }),
  externalSubjectId: text("external_subject_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("integration_identities_subject_unique").on(table.integrationId, table.externalSubjectId)]);

export const webLaunches = pgTable("web_launches", {
  id: uuid("id").defaultRandom().primaryKey(),
  webIntegrationId: uuid("web_integration_id").notNull().references(() => organizationClientIntegrations.id, { onDelete: "cascade" }),
  personId: uuid("person_id").notNull().references(() => organizationPeople.id, { onDelete: "cascade" }),
  operation: text("operation").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const webSessions = pgTable("web_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  webIntegrationId: uuid("web_integration_id").notNull().references(() => organizationClientIntegrations.id, { onDelete: "cascade" }),
  personId: uuid("person_id").notNull().references(() => organizationPeople.id, { onDelete: "cascade" }),
  operation: text("operation").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  memberId: uuid("member_id"),
  /** Migration-only link. Runtime code uses organization_people directly. */
  personId: uuid("person_id").references(() => organizationPeople.id),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Client-specific account references live here rather than on the internal user. */
export const clientIdentities = pgTable("client_identities", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  client: text("client").notNull(),
  subjectId: text("subject_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("client_identities_user_client_subject_unique").on(table.userId, table.client, table.subjectId)]);

export const members = pgTable("members", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  displayName: text("display_name").notNull(),
  calendarInviteEmail: text("calendar_invite_email").notNull(),
  status: text("status").notNull().default("active"),
  /** Migration-only link. Runtime code uses notification endpoints instead. */
  personId: uuid("person_id").references(() => organizationPeople.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("members_org_email_unique").on(table.organizationId, table.calendarInviteEmail)]);

export const calendarConnections = pgTable("calendar_connections", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  memberId: uuid("member_id").references(() => members.id, { onDelete: "cascade" }),
  personId: uuid("person_id").references(() => organizationPeople.id, { onDelete: "cascade" }),
  authorizedByPersonId: uuid("authorized_by_person_id").references(() => organizationPeople.id, { onDelete: "set null" }),
  kind: connectionKind("kind").notNull(),
  provider: text("provider").notNull().default("google_calendar"),
  calendarId: text("calendar_id"),
  accountEmail: text("account_email").notNull(),
  encryptedRefreshToken: text("encrypted_refresh_token").notNull(),
  status: connectionStatus("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("calendar_connections_one_organizer_per_org").on(table.organizationId).where(sql`${table.kind} = 'organizer'`),
  uniqueIndex("calendar_connections_one_availability_per_member").on(table.memberId).where(sql`${table.kind} = 'availability'`),
  uniqueIndex("calendar_connections_one_availability_per_person").on(table.personId).where(sql`${table.kind} = 'availability'`),
]);

export const oauthStates = pgTable("oauth_states", {
  state: text("state").primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  memberId: uuid("member_id").references(() => members.id, { onDelete: "cascade" }),
  personId: uuid("person_id").references(() => organizationPeople.id, { onDelete: "cascade" }),
  kind: connectionKind("kind").notNull(),
  codeVerifier: text("code_verifier").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

/** Exact deliverable destinations; client-specific addressing ends here. */
export const notificationEndpoints = pgTable("notification_endpoints", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  integrationId: uuid("integration_id").references(() => organizationClientIntegrations.id, { onDelete: "cascade" }),
  driverId: text("driver_id").notNull(),
  address: text("address").notNull(),
  configuration: jsonb("configuration").notNull().$type<Record<string, unknown>>().default({}),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("notification_endpoints_global_address_unique").on(table.organizationId, table.driverId, table.address).where(sql`${table.integrationId} IS NULL`),
  uniqueIndex("notification_endpoints_integration_address_unique").on(table.organizationId, table.integrationId, table.driverId, table.address).where(sql`${table.integrationId} IS NOT NULL`),
]);

export const personNotificationEndpointBindings = pgTable("person_notification_endpoint_bindings", {
  id: uuid("id").defaultRandom().primaryKey(),
  personId: uuid("person_id").notNull().references(() => organizationPeople.id, { onDelete: "cascade" }),
  endpointId: uuid("endpoint_id").notNull().references(() => notificationEndpoints.id, { onDelete: "cascade" }),
  purpose: text("purpose").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("person_notification_endpoint_binding_unique").on(table.personId, table.endpointId, table.purpose),
  uniqueIndex("person_notification_endpoint_one_calendar_invite").on(table.personId).where(sql`${table.purpose} = 'calendar_invite'`),
]);

export const meetings = pgTable("meetings", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  mode: text("mode").notNull(),
  status: meetingStatus("status").notNull(),
  title: text("title").notNull(),
  timeZone: text("time_zone").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  discoveryStartsAt: timestamp("discovery_starts_at", { withTimezone: true }),
  discoveryEndsAt: timestamp("discovery_ends_at", { withTimezone: true }),
  location: text("location"),
  notes: text("notes"),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
  createdByPersonId: uuid("created_by_person_id").references(() => organizationPeople.id),
  initiatedViaIntegrationId: uuid("initiated_via_integration_id").references(() => organizationClientIntegrations.id),
  statusAnnouncementEndpointId: uuid("status_announcement_endpoint_id").references(() => notificationEndpoints.id, { onDelete: "set null" }),
  notificationClient: text("notification_client").notNull().default("discord"),
  notificationChannelId: text("notification_channel_id").notNull(),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const candidateSlots = pgTable("candidate_slots", {
  id: uuid("id").defaultRandom().primaryKey(),
  meetingId: uuid("meeting_id").notNull().references(() => meetings.id, { onDelete: "cascade" }),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  connectedParticipantCount: integer("connected_participant_count").notNull(),
  unconnectedParticipantCount: integer("unconnected_participant_count").notNull(),
  rank: integer("rank").notNull(),
});

export const meetingParticipants = pgTable("meeting_participants", {
  id: uuid("id").defaultRandom().primaryKey(),
  meetingId: uuid("meeting_id").notNull().references(() => meetings.id, { onDelete: "cascade" }),
  memberId: uuid("member_id").references(() => members.id),
  personId: uuid("person_id").references(() => organizationPeople.id, { onDelete: "set null" }),
  kind: text("kind").notNull().default("registered_member"),
  displayNameSnapshot: text("display_name_snapshot").notNull(),
  calendarInviteEmailSnapshot: text("calendar_invite_email_snapshot").notNull(),
  attendanceRole: text("attendance_role").notNull().default("required"),
}, (table) => [
  uniqueIndex("meeting_participants_meeting_email_unique").on(table.meetingId, table.calendarInviteEmailSnapshot),
  uniqueIndex("meeting_participants_meeting_person_unique").on(table.meetingId, table.personId).where(sql`${table.personId} IS NOT NULL`),
]);

/** Tasks are independent from Calendar. sourceIntegrationId chooses their direct-notification route. */
export const tasks = pgTable("tasks", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  createdByPersonId: uuid("created_by_person_id").notNull().references(() => organizationPeople.id),
  sourceIntegrationId: uuid("source_integration_id").notNull().references(() => organizationClientIntegrations.id),
  title: text("title").notNull(),
  description: text("description"),
  dueAt: timestamp("due_at", { withTimezone: true }),
  timeZone: text("time_zone").notNull(),
  status: taskStatus("status").notNull().default("draft"),
  revision: integer("revision").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const taskAssignments = pgTable("task_assignments", {
  id: uuid("id").defaultRandom().primaryKey(),
  taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  personId: uuid("person_id").notNull().references(() => organizationPeople.id, { onDelete: "cascade" }),
  status: taskAssignmentStatus("status").notNull().default("open"),
  reminderPolicyOverride: taskReminderPolicy("reminder_policy_override"),
  reminderRevision: integer("reminder_revision").notNull().default(1),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("task_assignments_task_person_unique").on(table.taskId, table.personId)]);

export const personTaskReminderPreferences = pgTable("person_task_reminder_preferences", {
  personId: uuid("person_id").primaryKey().references(() => organizationPeople.id, { onDelete: "cascade" }),
  defaultPolicy: taskReminderPolicy("default_policy").notNull().default("daily_until_done"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const taskReminderDeliveries = pgTable("task_reminder_deliveries", {
  id: uuid("id").defaultRandom().primaryKey(),
  assignmentId: uuid("assignment_id").notNull().references(() => taskAssignments.id, { onDelete: "cascade" }),
  integrationId: uuid("integration_id").notNull().references(() => organizationClientIntegrations.id),
  endpointId: uuid("endpoint_id").references(() => notificationEndpoints.id),
  reminderRevision: integer("reminder_revision").notNull(),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
  status: taskReminderDeliveryStatus("status").notNull(),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("task_reminder_deliveries_assignment_revision_occurrence_unique").on(table.assignmentId, table.reminderRevision, table.scheduledFor)]);

/** Durable non-sensitive planner workflow state. Busy intervals never enter this schema. */
export const planningSessions = pgTable("planning_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
  createdByPersonId: uuid("created_by_person_id").references(() => organizationPeople.id),
  initiatedViaIntegrationId: uuid("initiated_via_integration_id").references(() => organizationClientIntegrations.id),
  statusAnnouncementEndpointId: uuid("status_announcement_endpoint_id").references(() => notificationEndpoints.id, { onDelete: "set null" }),
  kind: planningSessionKind("kind").notNull(),
  sourceMeetingId: uuid("source_meeting_id").references(() => meetings.id, { onDelete: "cascade" }),
  notificationClient: text("notification_client").notNull().default("discord"),
  notificationChannelId: text("notification_channel_id").notNull(),
  status: planningSessionStatus("status").notNull().default("collecting_audience"),
  title: text("title"),
  selectedStartsAt: timestamp("selected_starts_at", { withTimezone: true }),
  selectedEndsAt: timestamp("selected_ends_at", { withTimezone: true }),
  availabilityOverride: integer("availability_override").notNull().default(0),
  guestEmails: jsonb("guest_emails").notNull().$type<Array<{ displayName: string; email: string }>>().default([]),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const planningAttendees = pgTable("planning_attendees", {
  id: uuid("id").defaultRandom().primaryKey(),
  planningSessionId: uuid("planning_session_id").notNull().references(() => planningSessions.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  memberId: uuid("member_id").references(() => members.id, { onDelete: "set null" }),
  personId: uuid("person_id").references(() => organizationPeople.id, { onDelete: "set null" }),
  displayName: text("display_name").notNull(),
  source: jsonb("source").notNull().$type<Record<string, unknown>>(),
  readiness: planningAttendeeReadiness("readiness").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("planning_attendees_session_user_unique").on(table.planningSessionId, table.userId),
  uniqueIndex("planning_attendees_session_person_unique").on(table.planningSessionId, table.personId).where(sql`${table.personId} IS NOT NULL`),
]);

/** Each audience selection is retained before the effective audience is deduplicated. */
export const planningAudienceSelections = pgTable("planning_audience_selections", {
  id: uuid("id").defaultRandom().primaryKey(),
  planningSessionId: uuid("planning_session_id").notNull().references(() => planningSessions.id, { onDelete: "cascade" }),
  selectedByPersonId: uuid("selected_by_person_id").notNull().references(() => organizationPeople.id),
  integrationId: uuid("integration_id").references(() => organizationClientIntegrations.id, { onDelete: "set null" }),
  source: jsonb("source").notNull().$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const planningAudienceSelectionPeople = pgTable("planning_audience_selection_people", {
  selectionId: uuid("selection_id").notNull().references(() => planningAudienceSelections.id, { onDelete: "cascade" }),
  personId: uuid("person_id").notNull().references(() => organizationPeople.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.selectionId, table.personId] })]);

export const planningLaunchTokens = pgTable("planning_launch_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  planningSessionId: uuid("planning_session_id").notNull().references(() => planningSessions.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
});

export const planningBrowserSessions = pgTable("planning_browser_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  planningSessionId: uuid("planning_session_id").notNull().references(() => planningSessions.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const calendarEvents = pgTable("calendar_events", {
  meetingId: uuid("meeting_id").primaryKey().references(() => meetings.id, { onDelete: "cascade" }),
  calendarConnectionId: uuid("calendar_connection_id").notNull().references(() => calendarConnections.id),
  externalEventId: text("external_event_id").notNull(),
  htmlLink: text("html_link"),
  status: text("status").notNull().default("synced"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const providerInstallations = pgTable("provider_installations", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  providerId: text("provider_id").notNull(),
  status: providerInstallationStatus("status").notNull().default("configuring"),
  values: jsonb("values").notNull().$type<Record<string, string>>().default({}),
  configuredByUserId: uuid("configured_by_user_id").notNull().references(() => users.id),
  configuredByPersonId: uuid("configured_by_person_id").references(() => organizationPeople.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("provider_installations_org_provider_unique").on(table.organizationId, table.providerId)]);

export const roomBookings = pgTable("room_bookings", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  meetingId: uuid("meeting_id").notNull().references(() => meetings.id, { onDelete: "cascade" }),
  providerInstallationId: uuid("provider_installation_id").notNull().references(() => providerInstallations.id),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
  createdByPersonId: uuid("created_by_person_id").references(() => organizationPeople.id),
  status: roomBookingStatus("status").notNull().default("discovering"),
  room: jsonb("room").$type<Record<string, unknown>>(),
  providerReference: text("provider_reference"),
  failureReason: text("failure_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const jobs = pgTable("jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  payload: jsonb("payload").notNull(),
  status: jobStatus("status").notNull().default("ready"),
  attempts: integer("attempts").notNull().default(0),
  runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Domain work is persisted before Inngest is asked to execute it.  The old
 * jobs table remains only until the development reset lands; new code emits
 * through this table.
 */
export const outboxEvents = pgTable("outbox_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  aggregateId: uuid("aggregate_id").notNull(),
  expectedVersion: integer("expected_version"),
  payload: jsonb("payload").notNull().$type<Record<string, string | number | boolean | null>>().default({}),
  status: outboxStatus("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("outbox_events_type_aggregate_version_unique").on(table.type, table.aggregateId, table.expectedVersion)]);

/** Operational records make the resumable backfill observable and reviewable. */
export const genericPersonMigrationRuns = pgTable("generic_person_migration_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  status: text("status").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  summary: jsonb("summary").notNull().$type<Record<string, unknown>>().default({}),
});

export const genericPersonMigrationProgress = pgTable("generic_person_migration_progress", {
  organizationId: uuid("organization_id").primaryKey().references(() => organizations.id, { onDelete: "cascade" }),
  runId: uuid("run_id").references(() => genericPersonMigrationRuns.id, { onDelete: "set null" }),
  phase: text("phase").notNull(),
  lastLegacyUserId: uuid("last_legacy_user_id"),
  lastLegacyMemberId: uuid("last_legacy_member_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const genericPersonMigrationConflicts = pgTable("generic_person_migration_conflicts", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  legacyUserId: uuid("legacy_user_id"),
  legacyMemberId: uuid("legacy_member_id"),
  detail: jsonb("detail").notNull().$type<Record<string, unknown>>().default({}),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("generic_person_migration_conflict_unique").on(table.organizationId, table.kind, table.legacyUserId, table.legacyMemberId)]);
