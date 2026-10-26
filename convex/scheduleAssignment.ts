type ScheduleCandidate = { _id: unknown; name: string; days: string; department?: string; active: boolean; startTime: string; endTime: string };
export type ScheduleAssignment<T> =
  | { kind: 'unique'; tier: 'department' | 'default'; schedule: T }
  | { kind: 'none'; tier: null; candidates: T[] }
  | { kind: 'ambiguous'; tier: 'department' | 'default'; candidates: T[] };
const departmentKey = (department?: string) => (department || '').trim().toLowerCase();
export function scheduleDays(days: string): number[] {
  try {
    const parsed: unknown = JSON.parse(days);
    return Array.isArray(parsed) ? parsed.filter(day => Number.isInteger(day) && day >= 0 && day <= 6) : [];
  } catch { return []; }
}

// A tier expresses the existing department/default precedence, never a priority
// between schedules. Overlap within the effective tier has no authoritative winner.
export function resolveScheduleAssignment<T extends ScheduleCandidate>(department: string | undefined, schedules: T[], day: number): ScheduleAssignment<T> {
  const today = schedules.filter(schedule => schedule.active && scheduleDays(schedule.days).includes(day));
  const departmentMatches = departmentKey(department)
    ? today.filter(schedule => departmentKey(schedule.department) === departmentKey(department)) : [];
  const tier = departmentMatches.length ? 'department' : 'default';
  const candidates = departmentMatches.length ? departmentMatches : today.filter(schedule => !departmentKey(schedule.department));
  if (!candidates.length) return { kind: 'none', tier: null, candidates: [] };
  if (candidates.length === 1) return { kind: 'unique', tier, schedule: candidates[0] };
  return { kind: 'ambiguous', tier, candidates: [...candidates].sort((a, b) => String(a._id).localeCompare(String(b._id))) };
}
