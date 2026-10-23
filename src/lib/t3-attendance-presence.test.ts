import { describe, expect, it } from 'vitest';
import { latestAttendanceByWorker } from './attendance-presence';
const event = (id: string, event_type: string, timestamp: string, timestamp_utc?: string) => ({ id, worker_id: 'synthetic', event_type, timestamp, timestamp_utc });
describe('dashboard absolute attendance chronology', () => {
  it.each([false, true])('uses the later exit across DST fallback regardless of input order (%s)', reverse => {
    const arrival = event('a', 'clock_in', '2026-11-01T01:50:00', '2026-11-01T06:50:00.000Z');
    const departure = event('b', 'clock_out', '2026-11-01T01:10:00', '2026-11-01T07:10:00.000Z');
    expect(latestAttendanceByWorker(reverse ? [departure, arrival] : [arrival, departure]).get('synthetic')).toBe(departure);
  });
  it('distinguishes equal factory wall times using their original instants', () => {
    const arrival = event('a', 'clock_in', '2026-11-01T01:10:00', '2026-11-01T06:10:00.000Z');
    const departure = event('b', 'clock_out', '2026-11-01T01:10:00', '2026-11-01T07:10:00.000Z');
    expect(latestAttendanceByWorker([departure, arrival]).get('synthetic')?.event_type).toBe('clock_out');
  });
  it('keeps stable IDs for equal instants and includes corrections and ordinary legacy timestamps', () => {
    const arrival = event('a', 'clock_in', '2026-10-02T06:00:00');
    const corrected = event('z-correction', 'clock_out', '2026-10-02T14:30:00', '2026-10-02T19:30:00.000Z');
    const sameInstant = event('b-kiosk', 'clock_in', '2026-10-02T14:30:00', '2026-10-02T19:30:00.000Z');
    for (const events of [[arrival, corrected, sameInstant], [sameInstant, corrected, arrival]]) expect(latestAttendanceByWorker(events).get('synthetic')).toBe(corrected);
    expect(latestAttendanceByWorker([arrival, event('invalid', 'clock_out', 'broken')]).get('synthetic')).toBe(arrival);
  });
});
