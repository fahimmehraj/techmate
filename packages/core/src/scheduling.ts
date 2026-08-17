import type { DateTimeRange } from "./model.ts";

export type BusyInterval = DateTimeRange;

export const overlaps = (a: DateTimeRange, b: DateTimeRange) =>
  a.startsAt < b.endsAt && b.startsAt < a.endsAt;

/** Every connected required attendee must be free; an empty list is valid. */
export const isSlotFreeForEveryone = (slot: DateTimeRange, busy: BusyInterval[]) =>
  !busy.some((interval) => overlaps(slot, interval));

export function candidateSlots(input: {
  window: DateTimeRange;
  durationMinutes: number;
  granularityMinutes?: number;
  busyIntervals: BusyInterval[];
}): DateTimeRange[] {
  const step = (input.granularityMinutes ?? 30) * 60_000;
  const duration = input.durationMinutes * 60_000;
  const result: DateTimeRange[] = [];
  for (let start = input.window.startsAt.getTime(); start + duration <= input.window.endsAt.getTime(); start += step) {
    const slot = { startsAt: new Date(start), endsAt: new Date(start + duration) };
    if (isSlotFreeForEveryone(slot, input.busyIntervals)) result.push(slot);
  }
  return result;
}
