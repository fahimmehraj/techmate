import type { DateTimeRange } from "@technyu/core";

export function validatePlanningTime(time: DateTimeRange) {
  const duration = time.endsAt.getTime() - time.startsAt.getTime();
  if (!Number.isFinite(duration) || duration < 15 * 60_000 || duration > 8 * 60 * 60_000 || duration % (15 * 60_000) !== 0) {
    throw new Error("Meetings must be 15 minutes to 8 hours in 15-minute increments.");
  }
}

export function conflictingAttendeeIds(time: DateTimeRange, busyByAttendee: Array<{ attendeeId: string; busy: DateTimeRange[] }>) {
  return busyByAttendee.filter(({ busy }) => busy.some((interval) => interval.startsAt < time.endsAt && time.startsAt < interval.endsAt)).map(({ attendeeId }) => attendeeId);
}
