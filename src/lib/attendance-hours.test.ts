import { expect, it } from 'vitest';
import { buildHoursExportRows } from './attendance-hours';
import type { AttendanceWithWorker } from './types';

const event = (timestamp: string, event_type: 'clock_in' | 'clock_out', extra = {}): AttendanceWithWorker => ({
  id: `${timestamp}-${event_type}`, worker_id: 'worker', worker_name: 'Worker', worker_department: 'Assembly',
  kiosk_id: null, synced: 1, timestamp, event_type, ...extra,
});
const selected = '2026-09-14';

it('withholds hours when a missing clock-out is followed by a new workday', () => {
  expect(buildHoursExportRows([event(`${selected}T08:00:00`, 'clock_in')], [
    event('2026-09-15T08:00:00', 'clock_in'), event('2026-09-15T16:00:00', 'clock_out'),
  ], selected)[0]).toMatchObject({ hours: '', lastOut: '', ambiguous: true, note: expect.stringContaining('needs review') });
});

it('does not publish a partial daily total when another interval is ambiguous', () => {
  expect(buildHoursExportRows([
    event(`${selected}T08:00:00`, 'clock_in'), event(`${selected}T12:00:00`, 'clock_out'),
    event(`${selected}T13:00:00`, 'clock_in'),
  ], [event('2026-09-15T08:00:00', 'clock_in')], selected)[0]).toMatchObject({ hours: '', ambiguous: true });
});

it('preserves overnight intervals and ignores the next completed workday', () => {
  expect(buildHoursExportRows([event(`${selected}T22:00:00`, 'clock_in')], [
    event('2026-09-15T06:00:00', 'clock_out'), event('2026-09-15T08:00:00', 'clock_in'),
    event('2026-09-15T16:00:00', 'clock_out'),
  ], selected)[0]).toMatchObject({ hours: '8.00', lastOut: '2026-09-15T06:00:00', note: '' });
});

it('preserves the first same-day duplicate and excludes next-day-only workers', () => {
  expect(buildHoursExportRows([
    event(`${selected}T08:00:00`, 'clock_in'), event(`${selected}T08:01:00`, 'clock_in'),
    event(`${selected}T16:00:00`, 'clock_out'),
  ], [event('2026-09-15T08:00:00', 'clock_in', { worker_id: 'other' })], selected)).toMatchObject([{ hours: '8.00', note: '' }]);
});

it('uses absolute elapsed time through the repeated DST hour', () => {
  expect(buildHoursExportRows([
    event('2026-11-01T01:15:00', 'clock_out', { timestamp_utc: '2026-11-01T07:15:00Z' }),
    event('2026-11-01T01:45:00', 'clock_in', { timestamp_utc: '2026-11-01T06:45:00Z' }),
  ], [], '2026-11-01')[0]).toMatchObject({ hours: '0.50', note: '' });
});
