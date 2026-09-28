import type { AttendanceWithWorker } from './types';
import { createAttendanceClock } from './attendance-time';

export interface HoursExportRow {
  name: string; department: string; firstIn: string; lastOut: string;
  hours: string; note: string; ambiguous: boolean;
}

export function buildHoursExportRows(events: AttendanceWithWorker[], boundaryEvents: AttendanceWithWorker[], date: string): HoursExportRow[] {
  const clock = createAttendanceClock();
  const startsOnSelectedDate = (timestamp: string) => timestamp.startsWith(date);
  const byWorker = new Map<string, { name: string; department: string; events: AttendanceWithWorker[] }>();
  for (const event of [...events, ...boundaryEvents].sort(clock.compare)) {
    const entry = byWorker.get(event.worker_id) || {
      name: event.worker_name || event.worker_id,
      department: event.worker_department || '',
      events: [],
    };
    entry.events.push(event);
    byWorker.set(event.worker_id, entry);
  }

  const rows: HoursExportRow[] = [];
  for (const entry of byWorker.values()) {
    let totalMs = 0;
    let ambiguous = false;
    let firstIn: string | null = null;
    let lastOut: string | null = null;
    let openIn: AttendanceWithWorker | null = null;
    for (const event of entry.events) {
      if (event.event_type === 'clock_in') {
        if (openIn && !startsOnSelectedDate(event.timestamp)) {
          ambiguous = true;
          openIn = null;
        }
        // A next-day reentry cannot safely close the previous day's shift.
        // Only shifts STARTING on the selected date belong to this export
        // (next-day clock-ins are that day's shifts), and keep the FIRST
        // unmatched clock-in: entry kiosks can emit repeat clock_ins, and
        // replacing the open interval's start would undercount hours.
        if (!openIn && startsOnSelectedDate(event.timestamp)) {
          openIn = event;
          if (!firstIn) firstIn = event.timestamp;
        }
      } else if (event.event_type === 'clock_out' && openIn) {
        // A clock_out closes the open interval even after midnight.
        totalMs += clock.instantMs(event) - clock.instantMs(openIn);
        lastOut = event.timestamp;
        openIn = null;
      }
    }
    // Workers with no shift starting on this date (e.g. only an overnight
    // clock_out counted on the previous day's export) are omitted.
    if (!firstIn && !openIn && totalMs === 0) continue;
    const hours = totalMs > 0 ? (totalMs / 3_600_000).toFixed(2) : '0.00';
    rows.push({
      name: entry.name, department: entry.department, firstIn: firstIn || '',
      lastOut: lastOut || '', hours: ambiguous ? '' : hours, ambiguous,
      note: ambiguous ? 'needs review: next-day clock-in before clock-out; hours withheld' : openIn ? 'still clocked in' : '',
    });
  }

  return rows;
}
