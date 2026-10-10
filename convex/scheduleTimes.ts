export const SCHEDULE_TIME_ERROR = "Schedules must use HH:MM times with the end after the start on the same day. Overnight and 24-hour schedules are not supported.";

export function isSupportedScheduleTimeRange(start: unknown, end: unknown): boolean {
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  return typeof start === "string" && typeof end === "string" &&
    time.test(start) && time.test(end) && end > start;
}

// Shared factory-clock gate for schedule deadlines (shift exceptions and the
// shift briefing must agree). `now` is a factory-local "YYYY-MM-DDTHH:MM:SS"
// timestamp from getFactoryLocalTimestamp; the deadline has passed only once
// the factory clock is strictly after `${date}T${time}:00` (no grace period).
// A worker's last scan cannot tell us whether the shift has started or ended.
export function scheduleTimeHasPassed(date: string, time: string, now: string) {
  if (!/^(\d{1,2}):(\d{2})/.test(time)) return false;
  return now > `${date}T${time}:00`;
}
