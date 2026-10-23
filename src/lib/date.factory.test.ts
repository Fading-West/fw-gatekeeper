import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatFactoryLocalDateTime, getFactoryLocalDateString, resolveRequestDate } from './date';

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

describe('factory evidence formatting', () => {
  it.each(['UTC', 'Asia/Tokyo', 'Europe/Paris'])('formats instants and wall times for a %s viewer', timezone => {
    vi.stubEnv('TZ', timezone);
    const options = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true } as const;
    const format = (value: string) => formatFactoryLocalDateTime(value, '—', options).replace(/\s+/g, ' ');
    expect(format('2026-09-15T13:00:07Z')).toBe('08:00:07 AM');
    expect(format('2026-09-15T08:00:07-05:00')).toBe('08:00:07 AM');
    expect(format('2026-12-15T14:00:07Z')).toBe('08:00:07 AM');
    expect(format('2026-03-29T02:30:07')).toBe('02:30:07 AM');
    expect(format('2026-03-29 02:30:07.123')).toBe('02:30:07 AM');
    expect(format('2026-11-01T06:45:00Z')).toBe('01:45:00 AM');
    expect(format('2026-11-01T07:15:00Z')).toBe('01:15:00 AM');
    expect(formatFactoryLocalDateTime(null, 'No scan', options)).toBe('No scan');
    expect(formatFactoryLocalDateTime(undefined)).toBe('—');
    expect(format('invalid timestamp')).toBe('invalid timestamp');
  });
});
