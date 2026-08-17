import { describe, expect, test } from "bun:test";
import { candidateSlots, isSlotFreeForEveryone, overlaps } from "../../packages/core/src/scheduling.ts";

const at = (value: string) => new Date(value);

describe("availability scheduling", () => {
  test("treats every overlapping busy interval as disqualifying", () => {
    const slot = { startsAt: at("2026-09-08T18:00:00-04:00"), endsAt: at("2026-09-08T19:00:00-04:00") };
    expect(isSlotFreeForEveryone(slot, [{ startsAt: at("2026-09-08T18:30:00-04:00"), endsAt: at("2026-09-08T19:30:00-04:00") }])).toBeFalse();
  });

  test("permits adjacent but non-overlapping intervals", () => {
    const slot = { startsAt: at("2026-09-08T18:00:00-04:00"), endsAt: at("2026-09-08T19:00:00-04:00") };
    const busy = { startsAt: at("2026-09-08T19:00:00-04:00"), endsAt: at("2026-09-08T20:00:00-04:00") };
    expect(overlaps(slot, busy)).toBeFalse();
    expect(isSlotFreeForEveryone(slot, [busy])).toBeTrue();
  });

  test("generates only slots that do not overlap any attendee's busy time", () => {
    const slots = candidateSlots({
      window: { startsAt: at("2026-09-08T09:00:00-04:00"), endsAt: at("2026-09-08T12:00:00-04:00") },
      durationMinutes: 60,
      busyIntervals: [
        { startsAt: at("2026-09-08T09:30:00-04:00"), endsAt: at("2026-09-08T10:30:00-04:00") },
      ],
    });
    expect(slots.map((slot) => slot.startsAt.toISOString())).toEqual(["2026-09-08T14:30:00.000Z", "2026-09-08T15:00:00.000Z"]);
  });
});
