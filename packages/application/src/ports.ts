import type {
  Meeting,
  MeetingParticipant,
  OrganizerCalendarConnection,
  ClientKind,
} from "@technyu/core";

export type PendingOutboxEvent = {
  id: string;
  type: string;
  aggregateId: string;
  expectedVersion?: number;
  payload: Record<string, string | number | boolean | null>;
};

export type OutboxDispatchOutcome = {
  outboxId: string;
  status: "accepted" | "deferred" | "unsupported";
};

/** Delivers committed outbox rows. Implementations must never be called from a database transaction. */
export interface OutboxPublisher {
  publish(events: PendingOutboxEvent[]): Promise<OutboxDispatchOutcome[]>;
}

export interface CoordinatorRepository {
  createDirectMeeting(input: CreateDirectMeetingRecord): Promise<Meeting>;
  addParticipant(input: AddParticipantRecord): Promise<void>;
  getMeetingForConfirmation(meetingId: string): Promise<Meeting | undefined>;
  getMeetingParticipants(meetingId: string): Promise<MeetingParticipant[]>;
  markCalendarPending(meetingId: string, expectedVersion: number): Promise<PendingOutboxEvent | undefined>;
  getOrganizerConnection(organizationId: string): Promise<OrganizerCalendarConnection | undefined>;
}

export type CreateDirectMeetingRecord = Omit<Meeting, "id" | "version">;
export type AddParticipantRecord = MeetingParticipant;

export interface CalendarGateway {
  createEvent(input: {
    organizer: OrganizerCalendarConnection;
    meeting: Meeting;
    participants: MeetingParticipant[];
  }): Promise<{ externalEventId: string; htmlLink?: string }>;
}

export type DirectNotificationAction =
  | { kind: "complete_task_assignment"; assignmentId: string; label: string }
  | { kind: "change_task_reminder"; assignmentId: string; label: string };

export type DirectNotification = {
  client: Exclude<ClientKind, "web">;
  recipientSubjectId: string;
  title: string;
  body: string;
  actions: DirectNotificationAction[];
  idempotencyKey: string;
};

export type DirectNotificationResult = { status: "sent" };

/** A deliberately narrow outbound seam. Web can view tasks but is never an inbox. */
export interface DirectNotificationDispatcher {
  send(input: DirectNotification): Promise<DirectNotificationResult>;
}
