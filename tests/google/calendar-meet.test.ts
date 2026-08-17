import { describe, expect, test } from "bun:test";
import type { Meeting, MeetingParticipant } from "../../packages/core/src/model.ts";
import {
  assertGoogleMeetRequestAccepted,
  calendarEventPayload,
  calendarEventWriteUrl,
  googleMeetRequestId,
  shouldRequestGoogleMeet,
} from "../../packages/adapters/src/google/calendar.ts";

const meeting = {
  id: "61ced5d8-1f0a-4b74-853d-1de5c3e8bc11",
  title: "Tech@NYU Leadership",
  timeZone: "America/New_York",
  time: { startsAt: new Date("2026-09-08T22:00:00Z"), endsAt: new Date("2026-09-08T23:00:00Z") },
} as Meeting;

const participants = [{ calendarInviteEmailSnapshot: "alex@example.com", displayNameSnapshot: "Alex" }] as MeetingParticipant[];

describe("Google Meet event creation", () => {
  test("writes conference-enabled events with a stable, meeting-specific request ID", () => {
    const url = new URL(calendarEventWriteUrl({ base: "https://calendar.example/events" }));
    const payload = calendarEventPayload({ meeting, participants, requestGoogleMeet: true, includeEventId: true });

    expect(url.searchParams.get("sendUpdates")).toBe("all");
    expect(url.searchParams.get("conferenceDataVersion")).toBe("1");
    expect(payload.conferenceData?.createRequest.requestId).toBe(googleMeetRequestId(meeting.id));
    expect(payload.id).toBe("61ced5d81f0a4b74853d1de5c3e8bc11");
    expect(payload.id).toMatch(/^[a-v0-9]{5,1024}$/);
  });

  test("does not create a second Meet conference for an existing or pending one", () => {
    expect(shouldRequestGoogleMeet({ entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }] })).toBe(false);
    expect(shouldRequestGoogleMeet({ createRequest: { status: { statusCode: "pending" } } })).toBe(false);
    expect(shouldRequestGoogleMeet({ createRequest: { status: { statusCode: "success" } } })).toBe(false);
    expect(shouldRequestGoogleMeet()).toBe(true);
  });

  test("rejects a Calendar response that failed or ignored conference creation", () => {
    expect(() => assertGoogleMeetRequestAccepted({ createRequest: { status: { statusCode: "failure" } } })).toThrow("could not create a Google Meet link");
    expect(() => assertGoogleMeetRequestAccepted()).toThrow("did not accept the Google Meet request");
    expect(() => assertGoogleMeetRequestAccepted({ createRequest: { status: { statusCode: "pending" } } })).not.toThrow();
  });
});
