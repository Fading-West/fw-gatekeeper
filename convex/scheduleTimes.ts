import { getFactoryLocalTimestamp } from "./localDate";
import { createRecognitionTimestampSortKey } from "./recognitionTimestamp";

export const SCHEDULE_TIME_ERROR = "Schedules must use HH:MM times with the end after the start on the same day. Overnight and 24-hour schedules are not supported.";

export function isSupportedScheduleTimeRange(start: unknown, end: unknown): boolean {
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  return typeof start === "string" && typeof end === "string" &&
    time.test(start) && time.test(end) && end > start;
}

// `now` is an absolute timestamp. Resolve the factory-local deadline to an
// instant so a passed deadline cannot become future again during fall-back.
// Match attendance's policy: the first occurrence of an ambiguous wall time.
export function scheduleTimeHasPassed(
  date: string,
  time: string,
  now: string,
  timestampKey = createRecognitionTimestampSortKey(),
) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) return false;
  const deadline = `${date}T${time}:00`;
  const deadlineKey = timestampKey(deadline);
  const nowKey = timestampKey(now);
  if (deadlineKey && nowKey) return nowKey > deadlineKey; // Strictly after, no grace period.
  // A spring-forward deadline in the skipped hour has no instant. It becomes
  // due when the factory clock jumps past it; retain the existing behavior.
  return (getFactoryLocalTimestamp(now) || "") > deadline;
}

// Build once per query: reuse the timezone formatter/offsets and each result
// for workers sharing a deadline. Convex freezes `now` within the transaction.
export function createScheduleTimeHasPassed(now: string) {
  const timestampKey = createRecognitionTimestampSortKey();
  const results = new Map<string, boolean>();
  return (date: string, time: string) => {
    const deadline = `${date}T${time}`;
    if (!results.has(deadline)) results.set(deadline, scheduleTimeHasPassed(date, time, now, timestampKey));
    return results.get(deadline)!;
  };
}

// Use the same first-occurrence convention as schedule deadlines, preserving
// attendance's original instant when its display timestamp loses the offset.
export function createScheduleMinutesElapsed() {
  const timestampKey = createRecognitionTimestampSortKey();
  const deadlines = new Map<string, string>();
  return (date: string, time: string, event: { timestamp: string; chronologicalKey?: string }): number | null => {
    const deadline = `${date}T${time}:00`;
    if (!deadlines.has(deadline)) deadlines.set(deadline, timestampKey(deadline));
    const deadlineKey = deadlines.get(deadline)!;
    const eventKey = event.chronologicalKey ?? timestampKey(event.timestamp);
    if (deadlineKey && eventKey) {
      // Existing lateness checks ignore seconds, including within the start
      // minute and at the 30-minute severity boundary.
      return (Date.parse(`${eventKey.slice(0, 16)}:00Z`) - Date.parse(`${deadlineKey.slice(0, 16)}:00Z`)) / 60_000;
    }
    // A skipped spring-forward wall time has no instant. Retain the existing
    // wall-minute comparison, as scheduleTimeHasPassed does for these deadlines.
    const start = time.match(/^(\d{2}):(\d{2})$/);
    const punch = event.timestamp.match(/T(\d{2}):(\d{2})/);
    if (!start || !punch) return null;
    return Number(punch[1]) * 60 + Number(punch[2]) - (Number(start[1]) * 60 + Number(start[2]));
  };
}
