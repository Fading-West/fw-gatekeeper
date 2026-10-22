import { createAttendanceClock } from './attendance-time';
import { createLocalIsoTimestamp, DEFAULT_FACTORY_TIME_ZONE, getFactoryLocalDateString } from './date';
import type { AttendanceCorrection, AttendanceWithWorker, Worker } from './types';

// Direct corrections are made from the Activity Log without a generated
// exception. They use the same audited create mutation as /exceptions but
// never link a source exception.
export type DirectCorrectionRequest = {
  date: string;
  worker_id: string;
  action: 'add_clock_in' | 'add_clock_out' | 'void_event';
  corrected_timestamp?: string;
  original_attendance_id?: string;
  reason: string;
  supervisor_name?: string;
};

// What the dialog shows for a save whose outcome is unknown. It is stored
// with the frozen request so a reopened dialog can only retry that request.
export type PendingDirectCorrection = {
  request: DirectCorrectionRequest;
  request_id: string;
  worker_label: string;
  source?: { time: string; event_type: string; kiosk: string; attendance_id: string };
};

export type WorkerOption = { id: string; name: string; department: string; active: boolean };

export const REASON_MAX_LENGTH = 1000;
export const DUPLICATE_WINDOW_MS = 2 * 60_000;

export function reasonError(reason: string): string | null {
  const trimmed = reason.trim();
  if (!trimmed) return 'Enter a reason for this correction.';
  if (trimmed.length > REASON_MAX_LENGTH) return 'Keep the reason to 1,000 characters or fewer.';
  return null;
}

function factoryWallTime(now: Date) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: DEFAULT_FACTORY_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value || '00';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`;
}

// Resolve a factory wall time (no offset) to an instant with the shared
// Chicago resolver. A repeated fall-back time is its earlier occurrence;
// a spring-forward gap time does not exist and resolves to NaN.
export function factoryInstantMs(timestamp: string): number {
  return createAttendanceClock().instantMs({ timestamp });
}

export function futureCorrectionError(date: string, time: string | null, now: Date): string | null {
  const today = getFactoryLocalDateString(now);
  if (date > today) return 'This date is in the future. Corrections can only record attendance that already happened.';
  if (!time || date !== today) return null;
  const timestamp = createLocalIsoTimestamp(date, time);
  const instant = factoryInstantMs(timestamp);
  // Gap times have no instant; compare factory wall clocks instead.
  const future = Number.isFinite(instant) ? instant > now.getTime() : timestamp > factoryWallTime(now);
  return future ? 'This time has not happened yet today. Enter a time that already passed.' : null;
}

export function findPossibleDuplicate(
  events: AttendanceWithWorker[],
  workerId: string,
  eventType: 'clock_in' | 'clock_out',
  timestamp: string,
): AttendanceWithWorker | null {
  const clock = createAttendanceClock();
  const instant = clock.instantMs({ timestamp });
  if (!Number.isFinite(instant)) return null;
  return events.find((event) =>
    event.worker_id === workerId &&
    event.event_type === eventType &&
    Math.abs(clock.instantMs(event) - instant) <= DUPLICATE_WINDOW_MS,
  ) || null;
}

// Active workers plus any inactive identity that has evidence on the loaded
// day (effective events or correction history). `retained` carries identities
// seen earlier for the same selection so a void that removed a worker's last
// effective row does not drop them from the list.
export function buildWorkerOptions(
  activeWorkers: Worker[],
  events: AttendanceWithWorker[],
  corrections: AttendanceCorrection[],
  retained: ReadonlyMap<string, WorkerOption> = new Map(),
): Map<string, WorkerOption> {
  const options = new Map<string, WorkerOption>(retained);
  for (const event of events) {
    if (!event.worker_id) continue;
    const current = options.get(event.worker_id);
    options.set(event.worker_id, {
      id: event.worker_id,
      name: event.worker_name || current?.name || event.worker_id,
      department: event.worker_department || current?.department || '',
      active: current?.active ?? false,
    });
  }
  for (const correction of corrections) {
    if (!correction.worker_id) continue;
    const current = options.get(correction.worker_id);
    options.set(correction.worker_id, {
      id: correction.worker_id,
      name: correction.worker_name || current?.name || correction.worker_id,
      department: correction.worker_department || current?.department || '',
      active: current?.active ?? false,
    });
  }
  for (const worker of activeWorkers) {
    if (!worker.id || !worker.active) continue;
    options.set(worker.id, { id: worker.id, name: worker.name || worker.id, department: worker.department || '', active: true });
  }
  return options;
}

export function sortWorkerOptions(options: Iterable<WorkerOption>): WorkerOption[] {
  return [...options].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

// The uncertain save survives dialog close, date changes and reloads in this
// tab. The request ID itself is also kept by correctionRequestId().
const PENDING_KEY = 'gatekeeper:direct-correction-pending';
let memoryPending: PendingDirectCorrection | null = null;

export function readPendingDirectCorrection(): PendingDirectCorrection | null {
  try {
    const stored = sessionStorage.getItem(PENDING_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed && typeof parsed.request_id === 'string' && parsed.request && typeof parsed.request.date === 'string') return parsed;
    }
  } catch { /* Storage may be disabled; fall back to memory. */ }
  return memoryPending;
}

export function writePendingDirectCorrection(pending: PendingDirectCorrection): void {
  memoryPending = pending;
  try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending)); } catch { /* Keep the in-memory copy. */ }
}

export function clearPendingDirectCorrection(): void {
  memoryPending = null;
  try { sessionStorage.removeItem(PENDING_KEY); } catch { /* Storage may be disabled. */ }
}
