import { describe, expect, test } from "bun:test";
import { googleScopesFor } from "../../packages/adapters/src/google/oauth.ts";
import { normalizeGoogleBusyIntervals } from "../../packages/adapters/src/google/calendar.ts";

describe("Google OAuth scope separation", () => {
  test("organizer access is restricted to owned-calendar event management", () => {
    expect(googleScopesFor("organizer")).toEqual([
      "openid",
      "email",
      "https://www.googleapis.com/auth/calendar.events.owned",
    ]);
  });

  test("member access is restricted to free/busy", () => {
    expect(googleScopesFor("availability")).toEqual([
      "openid",
      "email",
      "https://www.googleapis.com/auth/calendar.events.freebusy",
    ]);
    expect(googleScopesFor("availability").join(" ")).not.toContain("calendar.events.owned");
  });
});

describe("Google FreeBusy normalization", () => {
  test("returns only normalized interval boundaries", () => {
    expect(normalizeGoogleBusyIntervals([{ start: "2026-09-08T22:00:00Z", end: "2026-09-08T23:00:00Z" }]))
      .toEqual([{ startsAt: new Date("2026-09-08T22:00:00Z"), endsAt: new Date("2026-09-08T23:00:00Z") }]);
  });
});
