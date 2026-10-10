import { expect, it } from 'vitest';
import { buildHoursExportRows, MAX_PLAUSIBLE_SHIFT_HOURS } from './attendance-hours';
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

it('withholds repeated clock-ins and excludes next-day-only workers', () => {
  expect(buildHoursExportRows([
    event(`${selected}T08:00:00`, 'clock_in'), event(`${selected}T08:01:00`, 'clock_in'),
    event(`${selected}T16:00:00`, 'clock_out'),
  ], [event('2026-09-15T08:00:00', 'clock_in', { worker_id: 'other' })], selected)).toMatchObject([{
    firstIn: `${selected}T08:00:00`, hours: '', ambiguous: true,
    note: 'needs review: repeated clock-in before clock-out; hours withheld',
  }]);
});

it('includes an exit-only worker with hours withheld after a missed morning entry (a)', () => {
  expect(buildHoursExportRows([event(`${selected}T17:00:00`, 'clock_out')], [], selected)).toEqual([{
    name: 'Worker', department: 'Assembly', firstIn: '', lastOut: `${selected}T17:00:00`,
    hours: '', ambiguous: true, note: 'needs review: clock-out without clock-in; hours withheld',
  }]);
});

it('includes every selected-day worker and isolates review status by worker', () => {
  expect(buildHoursExportRows([
    event(`${selected}T17:00:00`, 'clock_out'),
    event(`${selected}T08:00:00`, 'clock_in', { worker_id: 'normal', worker_name: 'Normal' }),
    event(`${selected}T16:00:00`, 'clock_out', { worker_id: 'normal', worker_name: 'Normal' }),
  ], [], selected)).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'Worker', hours: '', ambiguous: true }),
    expect.objectContaining({ name: 'Normal', hours: '8.00', ambiguous: false }),
  ]));
});

it('withholds the whole daily total and preserves the last exit after a missed lunch re-entry (b)', () => {
  expect(buildHoursExportRows([
    event(`${selected}T08:00:00`, 'clock_in'), event(`${selected}T12:00:00`, 'clock_out'),
    event(`${selected}T17:00:00`, 'clock_out'),
  ], [], selected)[0]).toMatchObject({
    firstIn: `${selected}T08:00:00`, lastOut: `${selected}T17:00:00`, hours: '', ambiguous: true,
    note: 'needs review: clock-out without clock-in; hours withheld',
  });
});

it('withholds a 33-hour interval after missing both the evening exit and next morning entry (c)', () => {
  const start = event(`${selected}T08:00:00`, 'clock_in');
  const end = event('2026-09-15T17:00:00', 'clock_out');
  // Both daily exports must flag the implausible interval, not pay it twice.
  for (const rows of [
    buildHoursExportRows([start], [end], selected),
    buildHoursExportRows([end], [], '2026-09-15', [start]),
  ]) {
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      hours: '', lastOut: end.timestamp, ambiguous: true,
      note: `needs review: interval exceeds ${MAX_PLAUSIBLE_SHIFT_HOURS}-hour maximum shift; hours withheld`,
    });
  }
});

it('recognizes a previous-day overnight shift and shows its exit without counting its hours twice', () => {
  const start = event('2026-09-13T22:00:00', 'clock_in');
  const end = event(`${selected}T06:00:00`, 'clock_out');
  expect(buildHoursExportRows([start], [end], '2026-09-13')[0]).toMatchObject({ hours: '8.00', ambiguous: false, note: '' });
  expect(buildHoursExportRows([end], [], selected, [start])).toMatchObject([{
    firstIn: '', lastOut: end.timestamp, hours: '0.00', ambiguous: false,
    note: 'overnight shift hours counted on 2026-09-13',
  }]);
});

it('exports a normal day without a review flag', () => {
  expect(buildHoursExportRows([
    event(`${selected}T16:00:00`, 'clock_out'), event(`${selected}T08:00:00`, 'clock_in'),
  ], [], selected)).toMatchObject([{
    firstIn: `${selected}T08:00:00`, lastOut: `${selected}T16:00:00`, hours: '8.00', ambiguous: false, note: '',
  }]);
});

it('sums multiple intervals without counting a previous overnight shift again', () => {
  expect(buildHoursExportRows([
    event(`${selected}T06:00:00`, 'clock_out'),
    event(`${selected}T08:00:00`, 'clock_in'), event(`${selected}T12:00:00`, 'clock_out'),
    event(`${selected}T13:00:00`, 'clock_in'), event(`${selected}T17:00:00`, 'clock_out'),
  ], [], selected, [event('2026-09-13T22:00:00', 'clock_in')])[0]).toMatchObject({
    firstIn: `${selected}T08:00:00`, lastOut: `${selected}T17:00:00`, hours: '8.00', ambiguous: false,
    note: 'overnight shift hours counted on 2026-09-13',
  });
});

it('accepts the maximum shift length but withholds longer intervals', () => {
  expect(MAX_PLAUSIBLE_SHIFT_HOURS).toBe(16);
  for (const [end, hours, ambiguous] of [
    ['16:00:00', '16.00', false], ['16:00:01', '', true],
  ] as const) {
    expect(buildHoursExportRows([
      event(`${selected}T00:00:00`, 'clock_in'), event(`${selected}T${end}`, 'clock_out'),
    ], [], selected)[0]).toMatchObject({ hours, ambiguous });
  }
});

it('withholds partial hours when the last interval is still open', () => {
  expect(buildHoursExportRows([
    event(`${selected}T08:00:00`, 'clock_in'), event(`${selected}T12:00:00`, 'clock_out'),
    event(`${selected}T13:00:00`, 'clock_in'),
  ], [], selected)[0]).toMatchObject({ hours: '', ambiguous: true, note: expect.stringContaining('still clocked in') });
});

it('does not let unrelated previous-day anomalies contaminate a normal selected day', () => {
  expect(buildHoursExportRows([
    event(`${selected}T08:00:00`, 'clock_in'), event(`${selected}T16:00:00`, 'clock_out'),
  ], [], selected, [
    event('2026-09-13T06:00:00', 'clock_out'),
    event('2026-09-13T08:00:00', 'clock_in'), event('2026-09-13T08:01:00', 'clock_in'),
    event('2026-09-13T16:00:00', 'clock_out'),
    event('2026-09-13T08:00:00', 'clock_in', { worker_id: 'other' }),
  ])).toMatchObject([{ hours: '8.00', ambiguous: false, note: '' }]);
});

it('flags repeated previous-day entries when their interval ends on the selected day', () => {
  expect(buildHoursExportRows([event(`${selected}T06:00:00`, 'clock_out')], [], selected, [
    event('2026-09-13T22:00:00', 'clock_in'), event('2026-09-13T22:01:00', 'clock_in'),
  ])[0]).toMatchObject({ hours: '', ambiguous: true, note: expect.stringContaining('repeated clock-in') });
});

it('withholds a new workday after the previous day was never clocked out', () => {
  expect(buildHoursExportRows([
    event(`${selected}T08:00:00`, 'clock_in'), event(`${selected}T16:00:00`, 'clock_out'),
  ], [], selected, [event('2026-09-13T08:00:00', 'clock_in')])[0]).toMatchObject({
    firstIn: `${selected}T08:00:00`, lastOut: `${selected}T16:00:00`, hours: '', ambiguous: true,
    note: expect.stringContaining('repeated clock-in'),
  });
});

it('uses absolute elapsed time through the repeated DST hour', () => {
  expect(buildHoursExportRows([
    event('2026-11-01T01:15:00', 'clock_out', { timestamp_utc: '2026-11-01T07:15:00Z' }),
    event('2026-11-01T01:45:00', 'clock_in', { timestamp_utc: '2026-11-01T06:45:00Z' }),
  ], [], '2026-11-01')[0]).toMatchObject({ hours: '0.50', note: '' });
});

it.each([
  ['2026-11-01', '2026-10-31T22:00:00', '2026-11-01T06:00:00', '9.00'],
  ['2026-03-08', '2026-03-07T22:00:00', '2026-03-08T06:00:00', '7.00'],
])('handles overnight elapsed time and day attribution across DST on %s', (date, startTime, endTime, hours) => {
  const start = event(startTime, 'clock_in');
  const end = event(endTime, 'clock_out');
  const previousDate = startTime.slice(0, 10);
  expect(buildHoursExportRows([start], [end], previousDate)[0]).toMatchObject({ hours, ambiguous: false });
  expect(buildHoursExportRows([end], [], date, [start])[0]).toMatchObject({
    hours: '0.00', ambiguous: false, note: `overnight shift hours counted on ${previousDate}`,
  });
});

it('uses factory-local day membership for offset timestamps', () => {
  expect(buildHoursExportRows([
    event('2026-09-15T01:00:00Z', 'clock_in'),
  ], [event('2026-09-15T09:00:00Z', 'clock_out')], selected)[0]).toMatchObject({ hours: '8.00', ambiguous: false });
});
