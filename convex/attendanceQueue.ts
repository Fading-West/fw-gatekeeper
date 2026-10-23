import { parseQueueCount } from "../src/lib/attendance-queue";

// Server-side record of the kiosk's attendance upload queue. `observedAt` is
// the server arrival time of the accepted report that carried the count, so
// contact without a valid count never refreshes it.
export type StoredAttendanceQueue = {
  lastValidCount: number;
  observedAt: string;
  latest: "reported" | "unknown";
};

export type AttendanceQueueStatus = "pending" | "clear" | "unknown";

export type AttendanceQueueObservation = {
  // What the latest accepted contact said about the queue.
  status: AttendanceQueueStatus;
  last_valid_count: number | null;
  observed_at: string | null;
  // A valid positive count stays a caveat until a newer valid zero arrives.
  caveat: boolean;
};

type QueueKiosk = {
  attendanceQueue?: StoredAttendanceQueue;
  health?: { queuedLogs?: number; reportedAt: string };
};

export const ATTENDANCE_QUEUE_SCOPE_NOTE =
  "This is current fleet-wide uncertainty: the queued records' attendance dates are unknown, so they are not assigned to this shift. It is incomplete attendance evidence, not proven data loss or a scanner failure.";

// Rows written before queue state existed fall back to their last health
// report until the next accepted update initializes the stored state.
export function storedAttendanceQueue(kiosk: QueueKiosk): StoredAttendanceQueue | null {
  if (kiosk.attendanceQueue) return kiosk.attendanceQueue;
  const count = parseQueueCount(kiosk.health?.queuedLogs);
  return count === undefined || !kiosk.health ? null
    : { lastValidCount: count, observedAt: kiosk.health.reportedAt, latest: "reported" };
}

// Call only for an accepted (newer) report, before its health replaces the
// prior health, so legacy evidence is captured rather than discarded.
export function nextAttendanceQueue(kiosk: QueueKiosk, queuedLogs: unknown, acceptedAt: string): StoredAttendanceQueue | null {
  const count = parseQueueCount(queuedLogs);
  if (count !== undefined) return { lastValidCount: count, observedAt: acceptedAt, latest: "reported" };
  const prior = storedAttendanceQueue(kiosk);
  return prior ? { ...prior, latest: "unknown" } : null;
}

export function observeAttendanceQueue(kiosk: QueueKiosk): AttendanceQueueObservation {
  const queue = storedAttendanceQueue(kiosk);
  if (!queue) return { status: "unknown", last_valid_count: null, observed_at: null, caveat: false };
  return {
    status: queue.latest === "unknown" ? "unknown" : queue.lastValidCount > 0 ? "pending" : "clear",
    last_valid_count: queue.lastValidCount,
    observed_at: queue.observedAt,
    caveat: queue.lastValidCount > 0,
  };
}
