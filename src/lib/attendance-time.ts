import { createRecognitionTimestampSortKey } from '../../convex/recognitionTimestamp';

type AttendanceTime = { timestamp: string; timestamp_utc?: string | null };

export function createAttendanceClock() {
  const resolve = createRecognitionTimestampSortKey();
  const key = (event: AttendanceTime) => resolve(event.timestamp_utc || event.timestamp);
  return {
    compare(a: AttendanceTime, b: AttendanceTime) {
      const left = key(a) || '~';
      const right = key(b) || '~';
      return left < right ? -1 : left > right ? 1 : 0;
    },
    instantMs(event: AttendanceTime) {
      // Older servers only expose factory wall time. The shared resolver uses
      // Chicago and the earlier occurrence of ambiguous legacy fall-back times.
      const instant = key(event);
      return instant ? Date.parse(`${instant}Z`.replace('.Z', 'Z')) : NaN;
    },
  };
}
