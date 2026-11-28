/** Existing string field: legacy single reasons or comma-separated faults. The
 * kiosk appends "; upload_quarantine: N attendance, M recognition" as one clause. */
/** Process-local kiosk observation: an attendance transaction failed and no
 * later punch has committed. A kiosk restart removes it (see pi-kiosk README). */
export const ATTENDANCE_WRITE_FAULT_REASON = 'attendance_write_failed';
export const ATTENDANCE_WRITE_FAULT_GUIDANCE =
  'An attendance write failed — verify the worker’s punch and local storage; retry or ask a supervisor.';

export function hasAttendanceWriteFault(reason?: string | null): boolean {
  return getKioskDegradedReasons(reason).includes(ATTENDANCE_WRITE_FAULT_REASON);
}

export function getKioskDegradedReasons(reason?: string | null): string[] {
  const reasons = (reason ?? '').split(';').flatMap(clause =>
    clause.trim().startsWith('upload_quarantine:') ? [clause] : clause.split(','));
  return [...new Set(reasons.map(value => value.trim()).filter(Boolean))];
}
