import type {
  CalendarConnectionId,
  EmailAddress,
  MeetingId,
  MemberId,
  OrganizationId,
  OrganizationClientIntegrationId,
  OrganizationPersonId,
  PlanningSessionId,
  TaskAssignmentId,
  TaskId,
  TeamId,
  UserId,
} from "./ids.ts";

export type ClientKind = "discord" | "slack" | "web";
export type TimeZone = string;

export type DateTimeRange = {
  startsAt: Date;
  endsAt: Date;
};

export type Organization = {
  id: OrganizationId;
  name: string;
  timeZone: TimeZone;
  discordGuildId: string;
};

export type OrganizationClientIntegration = {
  id: OrganizationClientIntegrationId;
  organizationId: OrganizationId;
  kind: ClientKind;
  status: "active" | "disabled";
};

export type OrganizationPerson = {
  id: OrganizationPersonId;
  organizationId: OrganizationId;
  displayName: string;
  invitationEmail?: EmailAddress;
  status: "active" | "inactive";
};

export type OrganizationOwner = {
  organizationId: OrganizationId;
  personId: OrganizationPersonId;
  grantedByPersonId?: OrganizationPersonId;
};

export type User = {
  id: UserId;
  organizationId: OrganizationId;
  memberId?: MemberId;
  status: "active" | "disabled";
};

/** A collaboration-account mapping. Discord is the only implementation today. */
export type ClientIdentity = {
  id: import("./ids.ts").ClientIdentityId;
  userId: UserId;
  client: Exclude<ClientKind, "web">;
  subjectId: string;
};

export type ClientAudienceReference =
  | { kind: "person"; client: Exclude<ClientKind, "web">; subjectId: string }
  | { kind: "group"; client: Exclude<ClientKind, "web">; subjectId: string };

/** Reusable organization audience. Client groups are resolved when selected. */
export type AudienceReference =
  | { kind: "person"; personId: OrganizationPersonId }
  | { kind: "team"; teamId: TeamId }
  | { kind: "client_group"; integrationId: OrganizationClientIntegrationId; subjectId: string };

export type ResolvedAudiencePerson = Pick<OrganizationPerson, "id" | "displayName">;

export type Team = {
  id: TeamId;
  organizationId: OrganizationId;
  name: string;
  createdByPersonId: OrganizationPersonId;
};

export type NotificationTarget = {
  client: Exclude<ClientKind, "web">;
  channelId: string;
};

/** A Calendar invite is possible for every active member without OAuth. */
export type Member = {
  id: MemberId;
  organizationId: OrganizationId;
  displayName: string;
  calendarInviteEmail: EmailAddress;
  status: "active" | "inactive";
};

/** Optional, user-consented source for free/busy data only. */
export type AvailabilityCalendarConnection = {
  id: CalendarConnectionId;
  organizationId: OrganizationId;
  memberId: MemberId;
  provider: "google_calendar";
  googleAccountEmail: EmailAddress;
  status: "active" | "revoked" | "expired";
};

/** Organization-owned credential that creates and edits every meeting event. */
export type OrganizerCalendarConnection = {
  id: CalendarConnectionId;
  organizationId: OrganizationId;
  calendarId: string;
  organizerEmail: EmailAddress;
  provider: "google_calendar";
  status: "active" | "revoked" | "expired";
};

export type MeetingStatus =
  | "draft"
  | "discovering"
  | "awaiting_confirmation"
  | "calendar_pending"
  | "scheduled"
  | "calendar_failed"
  | "cancelled";

export type Meeting = {
  id: MeetingId;
  organizationId: OrganizationId;
  mode: "direct" | "discovery";
  status: MeetingStatus;
  title: string;
  timeZone: TimeZone;
  time?: DateTimeRange;
  discoveryWindow?: DateTimeRange;
  location?: string;
  notes?: string;
  createdBy: UserId;
  notificationTarget: NotificationTarget;
  version: number;
};

/** Immutable recipient snapshot: later member edits are synchronized deliberately. */
export type MeetingParticipant = {
  meetingId: MeetingId;
  memberId?: MemberId;
  kind: "registered_member" | "email_guest";
  displayNameSnapshot: string;
  calendarInviteEmailSnapshot: EmailAddress;
  attendanceRole: "required" | "optional";
};

export type TaskStatus = "draft" | "open" | "completed" | "cancelled";
export type TaskAssignmentStatus = "open" | "completed";
export type TaskReminderPolicy = "daily_until_done" | "one_day_before" | "one_hour_before" | "none";

/** A task deliberately has no reminder policy; reminder choice belongs to its assignees. */
export type Task = {
  id: TaskId;
  organizationId: OrganizationId;
  createdByPersonId: OrganizationPersonId;
  sourceIntegrationId: OrganizationClientIntegrationId;
  title: string;
  description?: string;
  dueAt?: Date;
  timeZone: TimeZone;
  status: TaskStatus;
  revision: number;
};

export type TaskAssignment = {
  id: TaskAssignmentId;
  taskId: TaskId;
  personId: OrganizationPersonId;
  status: TaskAssignmentStatus;
  reminderPolicyOverride?: TaskReminderPolicy;
  reminderRevision: number;
  completedAt?: Date;
};

export type PersonTaskReminderPreference = {
  personId: OrganizationPersonId;
  defaultPolicy: TaskReminderPolicy;
};

export type TaskReminderDeliveryStatus = "sent" | "failed" | "skipped";

export type TaskReminderDelivery = {
  assignmentId: TaskAssignmentId;
  integrationId: OrganizationClientIntegrationId;
  scheduledFor: Date;
  status: TaskReminderDeliveryStatus;
  error?: string;
};

export type PlanningAttendeeReadiness = "ready" | "needs_invite_email" | "needs_availability" | "unverified";
export type MeetingPlanningSessionStatus = "collecting_audience" | "waiting_for_requirements" | "ready" | "confirmed" | "expired";

/** Persisted workflow state only. Free/busy intervals are never stored here. */
export type MeetingPlanningSession = {
  id: PlanningSessionId;
  organizationId: OrganizationId;
  createdBy: UserId;
  kind: "create" | "reschedule";
  sourceMeetingId?: MeetingId;
  notificationTarget: NotificationTarget;
  status: MeetingPlanningSessionStatus;
  title?: string;
  selectedTime?: DateTimeRange;
  availabilityOverride: boolean;
  expiresAt: Date;
};

export type PlanningAttendee = {
  id: import("./ids.ts").PlanningAttendeeId;
  planningSessionId: PlanningSessionId;
  userId?: UserId;
  memberId?: MemberId;
  displayName: string;
  source: ClientAudienceReference;
  readiness: PlanningAttendeeReadiness;
};

export type CandidateSlot = {
  id: import("./ids.ts").CandidateSlotId;
  meetingId: MeetingId;
  time: DateTimeRange;
  connectedParticipantCount: number;
  unconnectedParticipantCount: number;
  rank: number;
};


export type RoomRequirement = {
  attendeeCount: number;
  modality: "in_person" | "hybrid";
  requiredFeatures?: string[];
};

export type RoomCandidate = {
  providerId: string;
  externalRoomId: string;
  name: string;
  capacity?: number;
  availability: "available" | "unavailable" | "unknown";
  observedAt?: Date;
  bookingUrl?: string;
};

export type ProviderInstallationStatus = "configuring" | "enabled" | "disabled";
export type OrganizationProviderInstallation = {
  id: import("./ids.ts").ProviderInstallationId;
  organizationId: OrganizationId;
  providerId: string;
  status: ProviderInstallationStatus;
  values: Record<string, string>;
  configuredBy: UserId;
};

export type RoomBookingStatus = "discovering" | "awaiting_confirmation" | "submitting" | "request_submitted" | "failed";
export type RoomBooking = {
  id: import("./ids.ts").RoomBookingId;
  organizationId: OrganizationId;
  meetingId: MeetingId;
  providerInstallationId: import("./ids.ts").ProviderInstallationId;
  createdBy: UserId;
  status: RoomBookingStatus;
  room?: RoomCandidate;
  providerReference?: string;
  failureReason?: string;
};

/**
 * The setup dashboard is derived from persisted integrations.  It deliberately
 * has no separately writable status field, so a revoked Calendar credential
 * cannot leave setup looking ready.
 */
export type OrganizationSetupState = {
  phase: "calendar_required" | "calendar_reconnect_required" | "ready";
  organizer?: Pick<OrganizerCalendarConnection, "organizerEmail" | "status">;
  providers: Array<Pick<OrganizationProviderInstallation, "providerId" | "status">>;
};

export type ClientInvocation = {
  idempotencyKey: string;
  client: ClientKind;
  organizationId?: OrganizationId;
  /** Generic client boundary used by new application code. */
  integrationId?: OrganizationClientIntegrationId;
  personId?: OrganizationPersonId;
  discordGuildId?: string;
  discordUserId: string;
  /** Resolved/persisted internal user ID; absent only before organization setup. */
  userId?: UserId;
  discordRoleIds: string[];
  isAdministrator: boolean;
  channelId: string;
};
