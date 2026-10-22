import { describe, expect, it } from 'vitest';
import {
  buildWorkerOptions,
  factoryInstantMs,
  findPossibleDuplicate,
  futureCorrectionError,
  reasonError,
  sortWorkerOptions,
} from './direct-correction';
import type { AttendanceCorrection, AttendanceWithWorker, Worker } from './types';

const event = (overrides: Partial<AttendanceWithWorker>): AttendanceWithWorker => ({
  id: 'event', worker_id: 'worker-1', event_type: 'clock_in', kiosk_id: 'entry', timestamp: '2026-09-14T08:00:00',
  synced: 1, worker_name: 'Worker One', worker_department: 'Assembly', ...overrides,
});

describe('direct correction reason', () => {
  it('requires 1 to 1,000 trimmed characters', () => {
    expect(reasonError('   ')).toMatch(/Enter a reason/);
    expect(reasonError(` ${'x'.repeat(1000)} `)).toBeNull();
    expect(reasonError('x'.repeat(1001))).toMatch(/1,000/);
  });
});

describe('future guards use factory (Chicago) instants', () => {
  // 2026-09-14 15:30 UTC is 10:30 CDT in the factory.
  const now = new Date('2026-09-14T15:30:00Z');

  it('blocks a future factory date and allows past dates', () => {
    expect(futureCorrectionError('2026-09-15', null, now)).toMatch(/future/);
    expect(futureCorrectionError('2026-09-15', '08:00', now)).toMatch(/future/);
    expect(futureCorrectionError('2026-09-13', '23:59', now)).toBeNull();
  });

  it('blocks a time later today in factory time, regardless of the browser zone', () => {
    expect(futureCorrectionError('2026-09-14', '10:29', now)).toBeNull();
    expect(futureCorrectionError('2026-09-14', '10:31', now)).toMatch(/not happened yet/);
    // 05:00 UTC on Sept 15 is still Sept 14 at 00:00 CDT in the factory.
    const lateNight = new Date('2026-09-15T04:30:00Z');
    expect(futureCorrectionError('2026-09-15', null, lateNight)).toMatch(/future/);
    expect(futureCorrectionError('2026-09-14', '23:00', lateNight)).toBeNull();
    expect(futureCorrectionError('2026-09-14', '23:45', lateNight)).toMatch(/not happened yet/);
  });

  it('resolves a repeated fall-back time to its earlier occurrence', () => {
    // 2026-11-01 01:30 happens at 06:30Z (CDT) and again at 07:30Z (CST).
    expect(new Date(factoryInstantMs('2026-11-01T01:30:00')).toISOString()).toBe('2026-11-01T06:30:00.000Z');
    // During the second 01:10, an entered 01:30 is the earlier (past) occurrence.
    expect(futureCorrectionError('2026-11-01', '01:30', new Date('2026-11-01T07:10:00Z'))).toBeNull();
    // During the first 01:10, 01:30 is still ahead.
    expect(futureCorrectionError('2026-11-01', '01:30', new Date('2026-11-01T06:10:00Z'))).toMatch(/not happened yet/);
  });

  it('falls back to factory wall-clock order for a spring-forward gap time', () => {
    expect(Number.isNaN(factoryInstantMs('2026-03-08T02:30:00'))).toBe(true);
    // 07:30Z is 01:30 CST: the 02:30 wall time is ahead.
    expect(futureCorrectionError('2026-03-08', '02:30', new Date('2026-03-08T07:30:00Z'))).toMatch(/not happened yet/);
    // 09:00Z is 04:00 CDT: the 02:30 wall time has passed. The server
    // decides whether a gap time is valid (#176).
    expect(futureCorrectionError('2026-03-08', '02:30', new Date('2026-03-08T09:00:00Z'))).toBeNull();
  });
});

describe('possible duplicate detection', () => {
  const events = [
    event({ id: 'in', event_type: 'clock_in', timestamp: '2026-09-14T08:00:00' }),
    event({ id: 'other-worker', worker_id: 'worker-2', event_type: 'clock_out', timestamp: '2026-09-14T17:00:00' }),
  ];

  it('flags the same worker and event type within two minutes', () => {
    expect(findPossibleDuplicate(events, 'worker-1', 'clock_in', '2026-09-14T08:02:00')?.id).toBe('in');
    expect(findPossibleDuplicate(events, 'worker-1', 'clock_in', '2026-09-14T07:58:00')?.id).toBe('in');
  });

  it('ignores other event types, other workers and times beyond two minutes', () => {
    expect(findPossibleDuplicate(events, 'worker-1', 'clock_in', '2026-09-14T08:03:00')).toBeNull();
    expect(findPossibleDuplicate(events, 'worker-1', 'clock_out', '2026-09-14T08:00:00')).toBeNull();
    expect(findPossibleDuplicate(events, 'worker-1', 'clock_out', '2026-09-14T17:00:00')).toBeNull();
  });

  it('compares offset timestamps as instants', () => {
    const withOffset = [event({ id: 'utc', timestamp: '2026-09-14T08:00:00', timestamp_utc: '2026-09-14T13:00:00Z' })];
    expect(findPossibleDuplicate(withOffset, 'worker-1', 'clock_in', '2026-09-14T08:01:00')?.id).toBe('utc');
  });
});

describe('worker options', () => {
  const active: Worker[] = [
    { id: 'worker-1', name: 'Worker One', department: 'Assembly', photo_url: null, enrolled_at: '', active: 1 },
    { id: 'worker-3', name: 'Alpha', department: 'Paint', photo_url: null, enrolled_at: '', active: 1 },
  ];
  const correction = (overrides: Partial<AttendanceCorrection>) => ({
    id: 'c', date: '2026-09-14', worker_id: 'inactive-2', worker_name: 'Former Worker', worker_department: 'Weld',
    action: 'void_event', event_type: null, corrected_timestamp: null, original_attendance_id: 'raw', original_timestamp: null,
    original_event_type: null, related_exception_key: null, reason: 'Wrong person', supervisor_name: null,
    created_at: '', updated_at: '', ...overrides,
  } as AttendanceCorrection);

  it('combines active workers with inactive identities from the day’s events and history', () => {
    const options = buildWorkerOptions(active, [event({ worker_id: 'inactive-1', worker_name: 'Gone', worker_department: 'Cut' })], [correction({})]);
    expect(sortWorkerOptions(options.values())).toEqual([
      { id: 'worker-3', name: 'Alpha', department: 'Paint', active: true },
      { id: 'inactive-2', name: 'Former Worker', department: 'Weld', active: false },
      { id: 'inactive-1', name: 'Gone', department: 'Cut', active: false },
      { id: 'worker-1', name: 'Worker One', department: 'Assembly', active: true },
    ]);
  });

  it('keeps retained identities after a refresh drops their last effective row', () => {
    const first = buildWorkerOptions([], [event({ worker_id: 'inactive-1', worker_name: 'Gone' })], []);
    const refreshed = buildWorkerOptions(active, [], [], first);
    expect(refreshed.get('inactive-1')).toMatchObject({ name: 'Gone', active: false });
  });

  it('does not invent inactive workers without evidence and ignores inactive list rows', () => {
    const options = buildWorkerOptions([{ ...active[0], id: 'inactive-9', active: 0 }], [], []);
    expect(options.size).toBe(0);
  });
});
