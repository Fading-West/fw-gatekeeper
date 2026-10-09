import { createAttendanceClock } from './attendance-time';

type PresenceEvent = {
  id?: string;
  worker_id: string;
  event_type: string;
  timestamp: string;
  timestamp_utc?: string | null;
};

/** Factory wall-time strings can run backwards during the autumn DST change. */
export function latestAttendanceByWorker<T extends PresenceEvent>(events: T[]) {
  const clock = createAttendanceClock();
  const latest = new Map<string, T>();
  for (const event of events) {
    if (!Number.isFinite(clock.instantMs(event))) continue;
    const previous = latest.get(event.worker_id);
    const comparison = previous ? clock.compare(event, previous) : 1;
    if (!previous || comparison > 0 || (comparison === 0 && (event.id ?? '') > (previous.id ?? ''))) {
      latest.set(event.worker_id, event);
    }
  }
  return latest;
}
