import { describe, expect, test } from "bun:test";
import { confirmMeeting, startDirectMeeting } from "../../packages/application/src/meetings.ts";
import type { CoordinatorRepository } from "../../packages/application/src/ports.ts";

const organizationId = "org-1" as never;
const creatorId = "user-creator" as never;
const otherUserId = "user-other" as never;
const meeting = {
  id: "meeting-1" as never,
  organizationId,
  mode: "direct" as const,
  status: "awaiting_confirmation" as const,
  title: "Planning",
  timeZone: "America/New_York",
  time: { startsAt: new Date("2027-01-08T18:00:00Z"), endsAt: new Date("2027-01-08T19:00:00Z") },
  createdBy: creatorId,
  notificationTarget: { client: "discord" as const, channelId: "channel-1" },
  version: 1,
};

function invocation(userId: typeof creatorId | typeof otherUserId) {
  return {
    idempotencyKey: "interaction-1",
    client: "discord" as const,
    organizationId,
    discordUserId: userId as string,
    discordRoleIds: [],
    isAdministrator: true,
    channelId: "channel-1",
    userId,
  };
}

describe("meeting ownership", () => {
  test("lets any configured-server user start a direct meeting", async () => {
    let saved: unknown;
    const repository = {
      createDirectMeeting: async (input: unknown) => {
        saved = input;
        return { ...meeting, ...(input as object) };
      },
    } as unknown as CoordinatorRepository;

    await startDirectMeeting(repository, invocation(otherUserId), {
      title: "Open meeting",
      startsAt: new Date("2027-01-08T18:00:00Z"),
      durationMinutes: 60,
      timezone: "America/New_York",
    });

    expect((saved as { createdBy: unknown }).createdBy).toBe(otherUserId);
  });

  test("does not let even a Discord Administrator confirm someone else's meeting", async () => {
    let transitioned = false;
    const repository = {
      getMeetingForConfirmation: async () => meeting,
      markCalendarPending: async () => {
        transitioned = true;
        return { id: "outbox-1", type: "meeting.calendar_sync_requested", aggregateId: meeting.id, payload: {} };
      },
    } as unknown as CoordinatorRepository;

    await expect(confirmMeeting(repository, invocation(otherUserId), meeting.id)).rejects.toThrow("Only the meeting creator");
    expect(transitioned).toBeFalse();
  });

  test("lets the creator confirm their own meeting", async () => {
    let transitioned = false;
    const repository = {
      getMeetingForConfirmation: async () => meeting,
      markCalendarPending: async () => {
        transitioned = true;
        return { id: "outbox-1", type: "meeting.calendar_sync_requested", aggregateId: meeting.id, payload: {} };
      },
    } as unknown as CoordinatorRepository;

    const events = await confirmMeeting(repository, invocation(creatorId), meeting.id);
    expect(transitioned).toBeTrue();
    expect(events).toEqual([{ id: "outbox-1", type: "meeting.calendar_sync_requested", aggregateId: meeting.id, payload: {} }]);
  });
});
