export const SCHEDULE_TIME_ERROR = "Schedules must use HH:MM times with the end after the start on the same day. Overnight and 24-hour schedules are not supported.";

export function isSupportedScheduleTimeRange(start: unknown, end: unknown): boolean {
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  return typeof start === "string" && typeof end === "string" &&
    time.test(start) && time.test(end) && end > start;
}
