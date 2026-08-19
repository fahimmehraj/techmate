import { describe, expect, test } from "bun:test";
import { planningEnrollmentDmContent } from "../../packages/adapters/src/discord/planning-enrollment.ts";

describe("planning enrollment DMs", () => {
  test("identifies the meeting planner when an attendee needs an invite email", () => {
    expect(planningEnrollmentDmContent("planner-123", "invite_email")).toBe("<@planner-123> is planning a meeting and needs your calendar invite email.");
  });

  test("identifies the meeting planner when an attendee needs Google availability", () => {
    expect(planningEnrollmentDmContent("planner-123", "availability")).toBe("<@planner-123> is planning a meeting and needs you to connect Google free/busy availability.");
  });
});
