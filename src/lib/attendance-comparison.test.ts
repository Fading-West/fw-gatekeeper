import { describe, expect, it } from 'vitest';
import { ATTENDANCE_SCOPE, normalizeAttendanceComparison } from './attendance-comparison';

const date = '2026-09-02';
const signed = { version: 1, digest: 'a'.repeat(64), raw_punches: 1, corrections: 0, reversals: 0 };
const unchanged = { status: 'unchanged', scope: ATTENDANCE_SCOPE, compared_at: '2026-09-03T01:00:00Z', signed, current: signed };

describe('attendance comparison boundary', () => {
  it('retains valid equality and detects equal-count evidence changes', () => {
    expect(normalizeAttendanceComparison(unchanged, date, true).status).toBe('unchanged');
    const changed = { ...unchanged, status: 'changed', current: { ...signed, digest: 'b'.repeat(64) } };
    expect(normalizeAttendanceComparison(changed, date, true)).toMatchObject({ status: 'changed', activity_log_href: '/log?date=2026-09-02' });
  });

  it.each([
    undefined, null, {}, { ...unchanged, status: 'not_applicable' },
    { ...unchanged, signed: { ...signed, version: 2 } },
    { ...unchanged, current: { ...signed, digest: 'broken' } },
    { ...unchanged, current: { ...signed, raw_punches: -1 } },
    { ...unchanged, current: { ...signed, corrections: 0.5 } },
    { ...unchanged, current: { ...signed, reversals: Number.MAX_SAFE_INTEGER + 1 } },
    { ...unchanged, compared_at: 'bad timestamp' }, { ...unchanged, scope: 'everything is safe' },
    { ...unchanged, current: { ...signed, digest: 'b'.repeat(64) } },
    { ...unchanged, status: 'changed' },
  ])('never treats malformed or unsupported responses as equality', value => {
    expect(normalizeAttendanceComparison(value, date, true)).toMatchObject({ status: 'unknown', signed: null, current: null });
  });

  it('invalidates equality during failures and ignores untrusted review URLs', () => {
    expect(normalizeAttendanceComparison(unchanged, date, true, true).status).toBe('unknown');
    expect(normalizeAttendanceComparison({ ...unchanged, activity_log_href: 'https://unrelated.invalid' }, date, true).activity_log_href).toBe('/log?date=2026-09-02');
    expect(normalizeAttendanceComparison(unchanged, date, false).status).toBe('not_applicable');
  });

  it('retains the available signed evidence when the comparison alone fails', () => {
    expect(normalizeAttendanceComparison({ ...unchanged, status: 'unknown', current: null, reason: 'Current attendance unavailable.' }, date, true)).toMatchObject({ status: 'unknown', signed, current: null, reason: 'Current attendance unavailable.' });
  });
});
