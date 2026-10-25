import type { AttendanceComparison, SignedAttendanceEvidence } from './types';

export const ATTENDANCE_SCOPE = 'Attendance evidence for this factory date only';

function evidence(value: unknown): SignedAttendanceEvidence | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || typeof item.digest !== 'string' || !/^[a-f0-9]{64}$/.test(item.digest)) return null;
  if (![item.raw_punches, item.corrections, item.reversals].every(count => Number.isSafeInteger(count) && (count as number) >= 0)) return null;
  if ((item.raw_punches as number) + (item.corrections as number) + (item.reversals as number) > 4000) return null;
  return { version: 1, digest: item.digest, raw_punches: item.raw_punches as number, corrections: item.corrections as number, reversals: item.reversals as number };
}

/** Mixed deployments and malformed payloads must never imply fresh equality. */
export function normalizeAttendanceComparison(
  value: unknown,
  date: string,
  completed: boolean,
  unavailable = false,
): AttendanceComparison {
  const base: AttendanceComparison = {
    status: completed || unavailable ? 'unknown' : 'not_applicable',
    reason: completed || unavailable ? 'Attendance comparison unavailable or not recorded.' : null,
    scope: ATTENDANCE_SCOPE,
    compared_at: null,
    signed: null,
    current: null,
    activity_log_href: `/log?date=${encodeURIComponent(date)}`,
  };
  if (unavailable || !completed || !value || typeof value !== 'object') return base;
  const item = value as Record<string, unknown>;
  const signed = evidence(item.signed);
  const current = evidence(item.current);
  const comparedAt = typeof item.compared_at === 'string' && Number.isFinite(Date.parse(item.compared_at)) ? item.compared_at : null;
  if (item.status === 'unknown') return { ...base, signed, current, compared_at: comparedAt,
    reason: typeof item.reason === 'string' && item.reason ? item.reason : base.reason };
  if (!signed || !current || !comparedAt || item.scope !== ATTENDANCE_SCOPE) return base;
  const equal = signed.digest === current.digest && signed.raw_punches === current.raw_punches &&
    signed.corrections === current.corrections && signed.reversals === current.reversals;
  if ((item.status === 'unchanged' && !equal) || (item.status === 'changed' && equal) ||
      (item.status !== 'changed' && item.status !== 'unchanged')) return base;
  return { ...base, status: item.status, reason: null, signed, current, compared_at: comparedAt };
}

export function attendanceComparisonLabel(comparison: AttendanceComparison): string {
  return comparison.status === 'changed' ? 'Attendance changed since signoff' :
    comparison.status === 'unchanged' ? 'No attendance evidence changes detected' :
    comparison.status === 'unknown' ? 'Attendance comparison unavailable' : 'Attendance comparison begins at signoff';
}

export function attendanceEvidenceCounts(value: SignedAttendanceEvidence | null): string {
  return value ? `${value.raw_punches} raw punches, ${value.corrections} corrections, ${value.reversals} reversals` : 'Not recorded or unavailable';
}
