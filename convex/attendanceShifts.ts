import { getFactoryLocalDateKey } from "./localDate";
import { createRecognitionTimestampSortKey } from "./recognitionTimestamp";

// Shared payroll/exception policy: completed shifts belong to the clock-in
// factory date, and longer intervals cannot safely be inferred from punches.
export const MAX_PLAUSIBLE_SHIFT_HOURS = 16;
const MAX_SHIFT_MS = MAX_PLAUSIBLE_SHIFT_HOURS * 3_600_000;

type ShiftTimestamp = {
  timestamp: string;
  chronologicalKey?: string;
  timestamp_utc?: string | null;
};

export function createShiftClock() {
  const resolve = createRecognitionTimestampSortKey();
  const sortKey = (event: ShiftTimestamp) => event.chronologicalKey ?? resolve(event.timestamp_utc || event.timestamp);
  const instantMs = (event: ShiftTimestamp) => {
    const key = sortKey(event);
    return key ? Date.parse(`${key}Z`.replace(".Z", "Z")) : NaN;
  };
  return {
    instantMs,
    compare(a: ShiftTimestamp, b: ShiftTimestamp) {
      const left = sortKey(a) || "~";
      const right = sortKey(b) || "~";
      return left < right ? -1 : left > right ? 1 : 0;
    },
    isPlausibleShift(start: ShiftTimestamp, end: ShiftTimestamp) {
      const elapsed = instantMs(end) - instantMs(start);
      return Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= MAX_SHIFT_MS;
    },
  };
}

// Call per worker with bounded neighboring-day evidence. Retain the first
// repeated entry, as the hours CSV does, rather than shortening the shift.
export function pairShiftEvents<T extends ShiftTimestamp & { eventType: string }>(events: readonly T[], clock = createShiftClock()) {
  const pairedClockIns = new Set<T>();
  const pairedClockOuts = new Set<T>();
  const overlongClockOuts = new Set<T>();
  let openIns: T[] = [];
  const ordered = [...events].sort(clock.compare);
  for (const event of ordered) {
    if (event.eventType === "clock_in") {
      // A new day's entry cannot close yesterday's unclosed shift.
      if (openIns.length && getFactoryLocalDateKey(openIns[0].timestamp) !== getFactoryLocalDateKey(event.timestamp)) {
        openIns = [];
      }
      openIns.push(event);
    } else if (event.eventType === "clock_out" && openIns.length) {
      if (clock.isPlausibleShift(openIns[0], event)) {
        openIns.forEach(start => pairedClockIns.add(start));
        pairedClockOuts.add(event);
      } else if (clock.instantMs(event) - clock.instantMs(openIns[0]) > MAX_SHIFT_MS) {
        overlongClockOuts.add(event);
      }
      openIns = [];
    }
  }
  return { pairedClockIns, pairedClockOuts, overlongClockOuts, clock };
}
