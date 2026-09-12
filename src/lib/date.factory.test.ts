import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFactoryLocalDateString, resolveRequestDate } from './date';

afterEach(() => vi.unstubAllEnvs());
describe('factory day for remote supervisors', () => {
  it.each(['UTC', 'Asia/Tokyo', 'America/Los_Angeles'])('uses the factory day when the browser is in %s', timezone => {
    vi.stubEnv('TZ', timezone);
    // 8pm Central, already September 2 in UTC and Tokyo.
    const evening = new Date('2026-09-02T01:00:00Z');
    expect(getFactoryLocalDateString(evening)).toBe('2026-09-01');
    expect(resolveRequestDate(new URLSearchParams(), { now: evening })).toBe('2026-09-01');
    expect(getFactoryLocalDateString(new Date('2026-09-02T05:00:00Z'))).toBe('2026-09-02');
    // Standard time uses UTC-6, not the summer offset.
    expect(getFactoryLocalDateString(new Date('2026-12-02T05:59:59Z'))).toBe('2026-12-01');
    expect(getFactoryLocalDateString(new Date('2026-12-02T06:00:00Z'))).toBe('2026-12-02');
  });
});
