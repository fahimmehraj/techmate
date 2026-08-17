import type { Meeting, MeetingParticipant, OrganizerCalendarConnection } from "@technyu/core";
import { decryptSecret } from "../crypto.ts";

export type GoogleBusyInterval = { startsAt: Date; endsAt: Date };

export type GoogleConferenceData = {
  conferenceSolution?: { key?: { type?: string } };
  createRequest?: { status?: { statusCode?: "pending" | "success" | "failure" } };
  entryPoints?: Array<{ entryPointType?: string; uri?: string }>;
};

type GoogleCalendarEvent = {
  id: string;
  htmlLink?: string;
  conferenceData?: GoogleConferenceData;
};

export async function createGoogleCalendarEvent(input: {
  organizer: OrganizerCalendarConnection;
  refreshToken: string;
  meeting: Meeting;
  participants: MeetingParticipant[];
  existingEventId?: string;
}) {
  if (!input.meeting.time) throw new Error("A Calendar event requires a selected meeting time.");
  const time = input.meeting.time;
  const accessToken = await refreshAccessToken(input.refreshToken);
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(input.organizer.calendarId)}/events`;
  const existingConference = input.existingEventId
    ? await getGoogleCalendarConference({ base, accessToken, eventId: input.existingEventId })
    : undefined;
  const requestGoogleMeet = shouldRequestGoogleMeet(existingConference);
  const response = await fetch(calendarEventWriteUrl({ base, eventId: input.existingEventId }), {
    method: input.existingEventId ? "PATCH" : "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(calendarEventPayload({ meeting: input.meeting, participants: input.participants, requestGoogleMeet, includeEventId: !input.existingEventId })),
  });
  if (!response.ok) throw new Error(`Google Calendar event synchronization failed: ${await response.text()}`);
  const event = await response.json() as GoogleCalendarEvent;
  if (requestGoogleMeet) assertGoogleMeetRequestAccepted(event.conferenceData);
  return { externalEventId: event.id, htmlLink: event.htmlLink };
}

export function calendarEventWriteUrl(input: { base: string; eventId?: string }) {
  const target = input.eventId ? `${input.base}/${encodeURIComponent(input.eventId)}` : input.base;
  return `${target}?sendUpdates=all&conferenceDataVersion=1`;
}

export function calendarEventPayload(input: {
  meeting: Meeting;
  participants: MeetingParticipant[];
  requestGoogleMeet: boolean;
  includeEventId: boolean;
}) {
  if (!input.meeting.time) throw new Error("A Calendar event requires a selected meeting time.");
  const time = input.meeting.time;
  return {
    ...(input.includeEventId ? { id: calendarEventId(input.meeting.id) } : {}),
    summary: input.meeting.title,
    location: input.meeting.location,
    description: input.meeting.notes,
    start: { dateTime: time.startsAt.toISOString(), timeZone: input.meeting.timeZone },
    end: { dateTime: time.endsAt.toISOString(), timeZone: input.meeting.timeZone },
    attendees: input.participants.map((participant) => ({ email: participant.calendarInviteEmailSnapshot, displayName: participant.displayNameSnapshot })),
    ...(input.requestGoogleMeet ? { conferenceData: { createRequest: { requestId: googleMeetRequestId(input.meeting.id) } } } : {}),
  };
}

export function googleMeetRequestId(meetingId: string) {
  return `meeting-${compactMeetingId(meetingId)}`.slice(0, 1024);
}

export function shouldRequestGoogleMeet(conference?: GoogleConferenceData) {
  if (!conference) return true;
  const status = conference.createRequest?.status?.statusCode;
  if (status === "pending" || status === "success") return false;
  return !conference.entryPoints?.some((entryPoint) => entryPoint.entryPointType === "video" && Boolean(entryPoint.uri));
}

export function assertGoogleMeetRequestAccepted(conference?: GoogleConferenceData) {
  const status = conference?.createRequest?.status?.statusCode;
  if (status === "failure") throw new Error("Google Calendar could not create a Google Meet link for this meeting.");
  if (status !== "pending" && status !== "success") {
    throw new Error("Google Calendar did not accept the Google Meet request for this meeting.");
  }
}

function calendarEventId(meetingId: string) {
  // Google Calendar event IDs permit only lowercase base32hex characters
  // (a-v and 0-9). A compact UUID already satisfies that constraint and is
  // deterministic, making an event-create retry safe without making the ID
  // organization-specific.
  return compactMeetingId(meetingId).slice(0, 1024);
}

function compactMeetingId(meetingId: string) {
  return meetingId.replaceAll("-", "");
}

async function getGoogleCalendarConference(input: { base: string; accessToken: string; eventId: string }): Promise<GoogleConferenceData | undefined> {
  const response = await fetch(`${input.base}/${encodeURIComponent(input.eventId)}`, {
    headers: { Authorization: `Bearer ${input.accessToken}` },
  });
  if (!response.ok) throw new Error(`Google Calendar event lookup failed: ${await response.text()}`);
  return (await response.json() as GoogleCalendarEvent).conferenceData;
}

export async function deleteGoogleCalendarEvent(input: {
  organizer: OrganizerCalendarConnection;
  refreshToken: string;
  externalEventId: string;
}) {
  const accessToken = await refreshAccessToken(input.refreshToken);
  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(input.organizer.calendarId)}/events/${encodeURIComponent(input.externalEventId)}?sendUpdates=all`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok && response.status !== 404) throw new Error(`Google Calendar event cancellation failed: ${await response.text()}`);
}

/**
 * Uses only the Calendar FreeBusy endpoint. Event titles, attendees, and other
 * event details never cross this boundary.
 */
export async function getGoogleBusyIntervals(input: {
  refreshToken: string;
  range: { startsAt: Date; endsAt: Date };
  timeZone: string;
}): Promise<GoogleBusyInterval[]> {
  const accessToken = await refreshAccessToken(input.refreshToken);
  const response = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      timeMin: input.range.startsAt.toISOString(),
      timeMax: input.range.endsAt.toISOString(),
      timeZone: input.timeZone,
      items: [{ id: "primary" }],
    }),
  });
  if (!response.ok) throw new Error(`Google Calendar free/busy query failed: ${await response.text()}`);
  const payload = await response.json() as { calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }> };
  return normalizeGoogleBusyIntervals(payload.calendars?.primary?.busy ?? []);
}

export function normalizeGoogleBusyIntervals(intervals: Array<{ start: string; end: string }>): GoogleBusyInterval[] {
  return intervals.map((interval) => ({ startsAt: new Date(interval.start), endsAt: new Date(interval.end) }));
}

async function refreshAccessToken(encryptedRefreshToken: string) {
  const refreshToken = await decryptSecret(encryptedRefreshToken);
  const body = new URLSearchParams({
    client_id: required("GOOGLE_CLIENT_ID"),
    client_secret: required("GOOGLE_CLIENT_SECRET"),
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body });
  if (!response.ok) throw new Error(`Google access-token refresh failed: ${await response.text()}`);
  return (await response.json() as { access_token: string }).access_token;
}

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
