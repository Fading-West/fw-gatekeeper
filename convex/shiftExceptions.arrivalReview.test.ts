/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';
const modules = import.meta.glob('./**/*.ts');
const date = '2026-09-03';
const nextDate = '2026-09-04';
afterEach(() => vi.useRealTimers());

async function setup(firstClockIn: string | null) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${date}T15:00:00Z`)); // 10:00 factory time
  const t = convexTest(schema, modules);
  const ids = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'arrival-review@example.test' });
    await ctx.db.insert('portalMembers', { userId, role: 'admin', active: true, createdAt: date });
    const workerId = await ctx.db.insert('workers', { name: 'Late worker', department: 'Assembly', active: true, enrolledAt: date });
    await ctx.db.insert('schedules', { name: 'Day', department: 'Assembly', days: '[0,1,2,3,4,5,6]', startTime: '07:00', endTime: '15:00', active: true, createdAt: date });
    if (firstClockIn) await ctx.db.insert('attendance', { workerId, eventType: 'clock_in', timestamp: `${date}T${firstClockIn}:00`, synced: true });
    return { userId, workerId };
  });
  const admin = t.withIdentity({ subject: ids.userId });
  const find = async (type: string) => (await admin.query(api.shiftExceptions.summary, { date })).exceptions.find(row => row.type === type)!;
  const review = async (type: string, note: string) => {
    const source = await find(type);
    await admin.mutation(api.shiftExceptions.review, { exceptionKey: source.key, date, type, sourceFingerprint: source.source_fingerprint, status: 'reviewed', note });
    expect(await find(type)).toMatchObject({ status: 'reviewed', review_note: note });
  };
  const punch = (eventType: string, timestamp: string) => t.run(ctx => ctx.db.insert('attendance', { workerId: ids.workerId, eventType, timestamp, synced: true }));
  return { t, admin, find, review, punch, workerId: ids.workerId };
}

it('keeps a reviewed late arrival through the same-day clock-out and next-day clock-in', async () => {
  const { admin, find, review, punch } = await setup('07:45');
  expect(await find('late_arrival')).toMatchObject({ severity: 'critical', status: 'open' });
  await review('late_arrival', 'Doctor appointment, approved');

  vi.setSystemTime(new Date(`${date}T20:05:00Z`));
  await punch('clock_out', `${date}T15:00:00`);
  expect(await find('late_arrival')).toMatchObject({ status: 'reviewed', review_note: 'Doctor appointment, approved' });
  await admin.mutation(api.shiftCloseouts.save, { requestId: 'arrival-closeout', expectedRevision: null, date, action: 'complete' });

  vi.setSystemTime(new Date(`${nextDate}T12:05:00Z`));
  await punch('clock_in', `${nextDate}T07:00:00`);
  expect(await find('late_arrival')).toMatchObject({ status: 'reviewed', review_note: 'Doctor appointment, approved' });
  const closeout = await admin.query(api.shiftCloseouts.get, { date });
  expect(closeout.closeout?.status).toBe('completed');
  expect(closeout.blockers.map((blocker: { id: string }) => blocker.id)).not.toContain('critical_exceptions');
});

it('still reopens a reviewed late arrival when the day clock-in evidence changes', async () => {
  const { find, review, punch } = await setup('07:45');
  await review('late_arrival', 'Reviewed first scan');
  await punch('clock_in', `${date}T07:40:00`);
  expect(await find('late_arrival')).toMatchObject({ status: 'open', review_note: null, reviewed_at: null });
});

it('keeps a reviewed missing arrival when the worker clocks in the next day', async () => {
  const { find, review, punch } = await setup(null);
  await review('missing_arrival', 'Approved day off');
  vi.setSystemTime(new Date(`${nextDate}T12:05:00Z`));
  await punch('clock_in', `${nextDate}T07:00:00`);
  expect(await find('missing_arrival')).toMatchObject({ status: 'reviewed', review_note: 'Approved day off' });
});

it('still rejects a stale missing-arrival correction after an overnight exit changes the pairing window', async () => {
  const { admin, find, review, punch, workerId } = await setup(null);
  await punch('clock_in', '2026-09-02T23:00:00');
  await review('missing_arrival', 'Checking with the night lead');
  const source = await find('missing_arrival');
  await punch('clock_out', `${date}T08:00:00`);
  expect(await find('missing_arrival')).toMatchObject({ status: 'reviewed', review_note: 'Checking with the night lead' });
  await expect(admin.mutation(api.attendanceCorrections.create, { requestId: 'stale-arrival', date, workerId, action: 'add_clock_in',
    correctedTimestamp: `${date}T07:00:00`, relatedExceptionKey: source.key, sourceFingerprint: source.source_fingerprint,
    reason: 'Old draft' })).rejects.toThrow('source exception changed');
});

it('keeps an arrival review stored with the full-window fingerprint before this change', async () => {
  const { t, find } = await setup('07:45');
  const source = await find('late_arrival');
  await t.run(ctx => ctx.db.insert('exceptionReviews', { exceptionKey: source.key, date, type: 'late_arrival',
    sourceFingerprint: source.source_fingerprint, status: 'reviewed', note: 'Reviewed before deploy', reviewedAt: date, updatedAt: date }));
  expect(await find('late_arrival')).toMatchObject({ status: 'reviewed', review_note: 'Reviewed before deploy' });
});
