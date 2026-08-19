import { email, id, type ActorContext, type Meeting, type MeetingParticipant, type NotificationEndpointId } from "@technyu/core";
import { z } from "zod";
import type { CoordinatorRepository, PendingOutboxEvent } from "./ports.ts";

export const directMeetingInputSchema = z.object({
  title: z.string().trim().min(1).max(100),
  startsAt: z.coerce.date(),
  durationMinutes: z.number().int().min(15).max(480),
  timezone: z.string().min(1),
  location: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(2000).optional(),
});

export type DirectMeetingInput = z.infer<typeof directMeetingInputSchema>;

export async function startDirectMeeting(
  repository: CoordinatorRepository,
  actor: ActorContext,
  input: DirectMeetingInput,
  statusAnnouncementEndpointId?: NotificationEndpointId,
): Promise<Meeting> {
  if (input.startsAt <= new Date()) throw new Error("Meeting start time must be in the future.");
  const endsAt = new Date(input.startsAt.getTime() + input.durationMinutes * 60_000);
  return repository.createDirectMeeting({
    organizationId: actor.organizationId,
    mode: "direct",
    status: "awaiting_confirmation",
    title: input.title,
    timeZone: input.timezone,
    time: { startsAt: input.startsAt, endsAt },
    location: input.location || undefined,
    notes: input.notes || undefined,
    createdByPersonId: actor.personId,
    initiatedViaIntegrationId: actor.integrationId,
    statusAnnouncementEndpointId,
  });
}

export function buildExternalParticipants(meetingId: string, values: Array<{ name: string; inviteEmail: string }>): MeetingParticipant[] {
  return values.map((value) => ({
    meetingId: id<"MeetingId">(meetingId),
    kind: "email_guest",
    displayNameSnapshot: value.name.trim(),
    calendarInviteEmailSnapshot: email(value.inviteEmail),
    attendanceRole: "required",
  }));
}

export async function confirmMeeting(
  repository: CoordinatorRepository,
  actor: ActorContext,
  meetingId: string,
): Promise<PendingOutboxEvent[]> {
  const meeting = await repository.getMeetingForConfirmation(meetingId);
  if (!meeting || meeting.organizationId !== actor.organizationId) throw new Error("Meeting not found.");
  if (meeting.createdByPersonId !== actor.personId) throw new Error("Only the meeting creator can confirm it.");
  if (meeting.status !== "awaiting_confirmation") throw new Error("This meeting cannot be confirmed now.");
  const outbox = await repository.markCalendarPending(meetingId, meeting.version);
  if (!outbox) throw new Error("The meeting changed. Please reopen it.");
  return [outbox];
}
