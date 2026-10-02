import { describe, expect, it } from 'vitest';
import { resolveScheduleAssignment } from './scheduleAssignment';
const schedule = (_id: string, department?: string, overrides = {}) => ({ _id, name: _id, department, active: true, days: '[4]', startTime: '08:00', endTime: '17:00', ...overrides });
describe('department/day schedule authority', () => {
  it('uses a unique department match despite multiple defaults, independent of storage order', () => {
    const department = schedule('department', ' Assembly ');
    const candidates = [schedule('default-one'), schedule('default-two'), department];
    expect(resolveScheduleAssignment('ASSEMBLY', candidates, 4)).toEqual({ kind: 'unique', tier: 'department', schedule: department });
    expect(resolveScheduleAssignment('ASSEMBLY', candidates.reverse(), 4)).toEqual({ kind: 'unique', tier: 'department', schedule: department });
  });
  it('preserves ambiguity within the department tier without falling through to a default', () => {
    const candidates = [schedule('department-two', 'Assembly'), schedule('fallback'), schedule('department-one', 'Assembly')];
    const result = resolveScheduleAssignment('Assembly', candidates, 4);
    expect(result).toEqual({ kind: 'ambiguous', tier: 'department', candidates: [candidates[2], candidates[0]] });
    expect(resolveScheduleAssignment('Assembly', candidates.reverse(), 4)).toEqual(result);
  });
  it('uses the default tier only with no applicable department match and preserves default ambiguity', () => {
    const fallback = schedule('default');
    const candidates = [schedule('inactive', 'Assembly', { active: false }), schedule('other-day', 'Assembly', { days: '[5]' }), fallback];
    expect(resolveScheduleAssignment('Assembly', candidates, 4)).toEqual({ kind: 'unique', tier: 'default', schedule: fallback });
    expect(resolveScheduleAssignment('', [fallback, schedule('other-default', ' ')], 4).kind).toBe('ambiguous');
  });
  it('returns none when another department, inactive or other-day schedules cannot establish an assignment', () => {
    expect(resolveScheduleAssignment('Assembly', [schedule('other', 'Packing'), schedule('inactive', undefined, { active: false }), schedule('friday', undefined, { days: '[5]' })], 4)).toEqual({ kind: 'none', tier: null, candidates: [] });
  });
  it('keeps an unsupported unique department assignment instead of silently substituting a valid default', () => {
    const unsupported = schedule('overnight', 'Assembly', { startTime: '22:00', endTime: '06:00' });
    expect(resolveScheduleAssignment('Assembly', [schedule('fallback'), unsupported], 4)).toEqual({ kind: 'unique', tier: 'department', schedule: unsupported });
  });
});
