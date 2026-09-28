import { describe, expect, it } from 'vitest';
import { createAttendanceClock } from './attendance-time';

describe('attendance hours export chronology', () => {
  it('pairs a repeated-hour interval and computes its actual 30-minute duration', () => {
    const clock = createAttendanceClock();
    const start = { timestamp: '2026-11-01T01:45:00', timestamp_utc: '2026-11-01T06:45:00Z' };
    const end = { timestamp: '2026-11-01T01:15:00', timestamp_utc: '2026-11-01T07:15:00Z' };
    expect([end, start].sort(clock.compare)).toEqual([start, end]);
    expect((clock.instantMs(end) - clock.instantMs(start)) / 3_600_000).toBe(0.5);
  });

  it('preserves fractional ordering finer than Date milliseconds', () => {
    const clock = createAttendanceClock();
    const start = { timestamp: '2026-11-01T03:00:00.123456' };
    const end = { timestamp: '2026-11-01T03:00:00.123457', timestamp_utc: '2026-11-01T09:00:00.123457Z' };
    expect([end, start].sort(clock.compare)).toEqual([start, end]);
  });

  it('still calculates legacy local intervals spanning the DST change in Chicago', () => {
    const clock = createAttendanceClock();
    const start = { timestamp: '2026-11-01T00:30:00' };
    const end = { timestamp: '2026-11-01T02:30:00' };
    expect((clock.instantMs(end) - clock.instantMs(start)) / 3_600_000).toBe(3);
  });
});
