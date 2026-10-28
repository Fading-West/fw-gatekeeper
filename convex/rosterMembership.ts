import { getFactoryLocalDateKey, getFactoryLocalTimestamp } from "./localDate";
import { createRecognitionTimestampSortKey } from "./recognitionTimestamp";
import { createScheduleMinutesElapsed, isSupportedScheduleTimeRange } from "./scheduleTimes";

// How a factory date judges an active worker. A worker row's _creationTime is
// its join instant: enrolledAt is rewritten on re-enrollment and restore, and
// a restore by employee ID reuses the old row. See docs/roster-membership.md.
// - "omit": joined after the date's shift start with no effective attendance
//   on the date, so the worker was not on that shift's roster.
// - "no_arrival_checks": joined after the start but the door or an audited
//   correction recorded them on the date; keep their punches, never judge
//   missing or late.
// - "full": on the roster when the shift started.
export type RosterMembership = "omit" | "no_arrival_checks" | "full";

// Build once per query; both shift builders must share this rule so
// briefing-missing always equals exception-missing.
export function createRosterMembership() {
  const minutesElapsed = createScheduleMinutesElapsed();
  const timestampKey = createRecognitionTimestampSortKey();
  const joinedAfterStart = (worker: any, date: string, schedule: any | null) => {
    if (typeof worker._creationTime !== "number" || !Number.isFinite(worker._creationTime)) return false;
    const joinedAt = new Date(worker._creationTime).toISOString();
    const joinDate = getFactoryLocalDateKey(joinedAt);
    if (!joinDate || joinDate < date) return false;
    if (joinDate > date) return true;
    // Same date: without a unique supported start there is nothing to compare,
    // so keep today's behavior. Equal minutes and unknown instants count as before.
    if (!schedule || !isSupportedScheduleTimeRange(schedule.startTime, schedule.endTime)) return false;
    const elapsed = minutesElapsed(date, schedule.startTime, {
      timestamp: getFactoryLocalTimestamp(joinedAt) || "",
      chronologicalKey: timestampKey(joinedAt),
    });
    return elapsed !== null && elapsed > 0;
  };
  // `schedule` is the worker's unique assigned schedule for the date, if any.
  // `eventsOnDate` is effective attendance belonging to the factory date only.
  return (worker: any, date: string, schedule: any | null, eventsOnDate: any[]): RosterMembership => {
    if (!joinedAfterStart(worker, date, schedule)) return "full";
    return eventsOnDate.length > 0 ? "no_arrival_checks" : "omit";
  };
}
