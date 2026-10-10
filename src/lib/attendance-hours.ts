import type { AttendanceWithWorker } from './types';
import { createAttendanceClock } from './attendance-time';
import { getFactoryLocalDateString } from './date';

// Payroll policy: longer intervals cannot safely be inferred from punches.
export const MAX_PLAUSIBLE_SHIFT_HOURS = 16;

export interface HoursExportRow {
  name: string; department: string; firstIn: string; lastOut: string;
  hours: string; note: string; ambiguous: boolean;
}

export function buildHoursExportRows(
  events: AttendanceWithWorker[],
  boundaryEvents: AttendanceWithWorker[],
  date: string,
  previousEvents: AttendanceWithWorker[] = [],
): HoursExportRow[] {
  const clock = createAttendanceClock();
  const localDays = new Map<AttendanceWithWorker, string>();
  const localDay = (event: AttendanceWithWorker) => {
    const cached = localDays.get(event);
    if (cached) return cached;
    const instant = clock.instantMs(event);
    const day = Number.isFinite(instant) ? getFactoryLocalDateString(new Date(instant)) : event.timestamp.slice(0, 10);
    localDays.set(event, day);
    return day;
  };
  const byWorker = new Map<string, { name: string; department: string; events: AttendanceWithWorker[] }>();
  const orderedEvents = [...previousEvents, ...events, ...boundaryEvents].sort(clock.compare);
  // Anchor row order and labels to this day's punches. Neighboring history
  // supplies pairing evidence without changing an otherwise normal CSV row.
  for (const event of orderedEvents) {
    if (localDay(event) !== date || byWorker.has(event.worker_id)) continue;
    byWorker.set(event.worker_id, {
      name: event.worker_name || event.worker_id,
      department: event.worker_department || '',
      events: [],
    });
  }
  for (const event of orderedEvents) {
    byWorker.get(event.worker_id)?.events.push(event);
  }

  const rows: HoursExportRow[] = [];
  for (const entry of byWorker.values()) {
    let totalMs = 0;
    const reviewReasons = new Set<string>();
    const notes = new Set<string>();
    let firstIn: string | null = null;
    let lastOut: string | null = null;
    let openIn: AttendanceWithWorker | null = null;
    const openReasons = new Set<string>();
    for (const event of entry.events) {
      const day = localDay(event);
      const startsOnSelectedDate = openIn && localDay(openIn) === date;
      // Next-day evidence only closes (or invalidates) this day's open shift.
      if (day > date && !startsOnSelectedDate) break;
      if (event.event_type === 'clock_in') {
        if (day > date) {
          reviewReasons.add('next-day clock-in before clock-out');
          openIn = null;
          break;
        }
        if (day === date && !firstIn) firstIn = event.timestamp;
        if (openIn) {
          openReasons.add('repeated clock-in before clock-out');
          if (day === date) {
            openReasons.forEach((reason) => reviewReasons.add(reason));
            // A new day cannot safely continue yesterday's unclosed shift.
            if (!startsOnSelectedDate) openIn = event;
          }
        } else {
          openIn = event;
          openReasons.clear();
        }
      } else if (event.event_type === 'clock_out') {
        // Preserve the actual last exit even when it cannot be paired.
        if (day === date || startsOnSelectedDate) lastOut = event.timestamp;
        if (!openIn) {
          if (day === date) reviewReasons.add('clock-out without clock-in');
          continue;
        }
        const durationMs = clock.instantMs(event) - clock.instantMs(openIn);
        if (day === date || startsOnSelectedDate) {
          openReasons.forEach((reason) => reviewReasons.add(reason));
          if (!Number.isFinite(durationMs) || durationMs < 0) {
            reviewReasons.add('invalid interval timestamps');
          } else if (durationMs > MAX_PLAUSIBLE_SHIFT_HOURS * 3_600_000) {
            reviewReasons.add(`interval exceeds ${MAX_PLAUSIBLE_SHIFT_HOURS}-hour maximum shift`);
          }
          // Completed shifts are paid on their start date, never twice.
          if (startsOnSelectedDate) totalMs += durationMs;
          else notes.add(`overnight shift hours counted on ${localDay(openIn)}`);
        }
        openIn = null;
        openReasons.clear();
      }
    }
    if (openIn && localDay(openIn) === date) {
      reviewReasons.add('clock-in without clock-out (still clocked in)');
    }
    const ambiguous = reviewReasons.size > 0;
    const hours = totalMs > 0 ? (totalMs / 3_600_000).toFixed(2) : '0.00';
    rows.push({
      name: entry.name, department: entry.department, firstIn: firstIn || '',
      lastOut: lastOut || '', hours: ambiguous ? '' : hours, ambiguous,
      // Withhold the entire row, including otherwise valid partial intervals.
      note: ambiguous ? `needs review: ${[...reviewReasons].join('; ')}; hours withheld` : [...notes].join('; '),
    });
  }

  return rows;
}
