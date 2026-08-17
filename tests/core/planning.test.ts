import { describe, expect, test } from "bun:test";
import { conflictingAttendeeIds, validatePlanningTime } from "../../packages/application/src/planning.ts";

describe("interactive planning selection", () => {
  test("accepts 15-minute selections through eight hours", () => {
    expect(() => validatePlanningTime({ startsAt: new Date("2026-09-08T18:00:00Z"), endsAt: new Date("2026-09-08T18:15:00Z") })).not.toThrow();
    expect(() => validatePlanningTime({ startsAt: new Date("2026-09-08T18:00:00Z"), endsAt: new Date("2026-09-09T02:00:00Z") })).not.toThrow();
  });

  test("rejects unsnapped or oversized selections", () => {
    expect(() => validatePlanningTime({ startsAt: new Date("2026-09-08T18:00:00Z"), endsAt: new Date("2026-09-08T18:10:00Z") })).toThrow();
    expect(() => validatePlanningTime({ startsAt: new Date("2026-09-08T18:00:00Z"), endsAt: new Date("2026-09-09T03:00:00Z") })).toThrow();
  });

  test("reports every attendee with an overlapping busy interval", () => {
    const selected = { startsAt: new Date("2026-09-08T18:00:00Z"), endsAt: new Date("2026-09-08T19:00:00Z") };
    expect(conflictingAttendeeIds(selected, [
      { attendeeId: "alex", busy: [{ startsAt: new Date("2026-09-08T18:30:00Z"), endsAt: new Date("2026-09-08T19:30:00Z") }] },
      { attendeeId: "jamie", busy: [{ startsAt: new Date("2026-09-08T19:00:00Z"), endsAt: new Date("2026-09-08T20:00:00Z") }] },
    ])).toEqual(["alex"]);
  });
});
