import { email, id, type ClientInvocation, type Meeting, type MeetingParticipant } from "@technyu/core";
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
  invocation: ClientInvocation,
  input: DirectMeetingInput,
): Promise<Meeting> {
  if (!invocation.organizationId) throw new Error("Run /setup before creating meetings.");
  if (!invocation.userId) throw new Error("Unable to resolve the current user.");
  if (input.startsAt <= new Date()) throw new Error("Meeting start time must be in the future.");
  const endsAt = new Date(input.startsAt.getTime() + input.durationMinutes * 60_000);
  return repository.createDirectMeeting({
    organizationId: invocation.organizationId,
    mode: "direct",
    status: "awaiting_confirmation",
    title: input.title,
    timeZone: input.timezone,
    time: { startsAt: input.startsAt, endsAt },
    location: input.location || undefined,
    notes: input.notes || undefined,
    createdBy: invocation.userId,
    notificationTarget: { client: "discord", channelId: invocation.channelId },
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
  invocation: ClientInvocation,
  meetingId: string,
): Promise<PendingOutboxEvent[]> {
  const meeting = await repository.getMeetingForConfirmation(meetingId);
  if (!meeting || meeting.organizationId !== invocation.organizationId) throw new Error("Meeting not found.");
  if (meeting.createdBy !== invocation.userId) throw new Error("Only the meeting creator can confirm it.");
  if (meeting.status !== "awaiting_confirmation") throw new Error("This meeting cannot be confirmed now.");
  const outbox = await repository.markCalendarPending(meetingId, meeting.version);
  if (!outbox) throw new Error("The meeting changed. Please reopen it.");
  return [outbox];
}
