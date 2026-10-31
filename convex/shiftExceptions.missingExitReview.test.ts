/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';
const modules = import.meta.glob('./**/*.ts');
const date = '2026-09-03';
const nextDate = '2026-09-04';
afterEach(() => vi.useRealTimers());

async function setup(clockIn = '07:00') {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-02T12:00:00Z'));
  const t = convexTest(schema, modules);
  const ids = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'missing-exit-review@example.test' });
    await ctx.db.insert('portalMembers', { userId, role: 'admin', active: true, createdAt: date });
    const workerId = await ctx.db.insert('workers', { name: 'Forgot exit', department: 'Assembly', active: true, enrolledAt: date });
    const scheduleId = await ctx.db.insert('schedules', { name: 'Day', department: 'Assembly', days: '[0,1,2,3,4,5,6]', startTime: '07:00', endTime: '15:00', active: true, createdAt: date });
    await ctx.db.insert('attendance', { workerId, eventType: 'clock_in', timestamp: `${date}T${clockIn}:00`, synced: true });
    return { userId, workerId, scheduleId };
  });
  vi.setSystemTime(new Date(`${nextDate}T04:00:00Z`)); // 23:00 on the source factory date.
  const admin = t.withIdentity({ subject: ids.userId });
  const find = async () => (await admin.query(api.shiftExceptions.summary, { date })).exceptions.find(row => row.type === 'missing_clock_out')!;
  const source = await find();
  expect(source).toMatchObject({ status: 'open' });
  const review = () => admin.mutation(api.shiftExceptions.review, { exceptionKey: source.key, date, type: source.type,
    sourceFingerprint: source.source_fingerprint, status: 'reviewed', note: 'Lead confirmed exit; payroll notified' });
  const punch = (eventType: string, timestamp: string) => t.run(ctx => ctx.db.insert('attendance', { workerId: ids.workerId, eventType, timestamp, synced: true }));
  return { t, admin, find, review, punch, source, ...ids };
}

it('keeps the review and signed closeout clear after next-day punches beyond the pairing window', async () => {
  const { admin, find, review, punch, source } = await setup();
  await review();
  expect(await find()).toMatchObject({ status: 'reviewed' });
  await admin.mutation(api.shiftCloseouts.save, { requestId: 'missing-exit-closeout', expectedRevision: null, date, action: 'complete' });
  expect((await admin.query(api.shiftCloseouts.get, { date })).blockers).toEqual([]);

  vi.setSystemTime(new Date(`${nextDate}T21:00:00Z`));
  await punch('clock_in', `${nextDate}T07:00:00`);
  const after = await find();
  expect(after.key).toBe(source.key);
  expect(after.source_evidence).toBe(source.source_evidence);
  expect(after.source_fingerprint).not.toBe(source.source_fingerprint);
  expect(after).toMatchObject({ status: 'reviewed', review_note: 'Lead confirmed exit; payroll notified' });
  await punch('clock_out', `${nextDate}T15:00:00`);
  expect(await find()).toMatchObject({ status: 'reviewed' });
  const closeout = await admin.query(api.shiftCloseouts.get, { date });
  expect(closeout.closeout?.status).toBe('completed');
  expect(closeout.blockers.map((blocker: { id: string }) => blocker.id)).not.toContain('missing_clock_outs');
});

it.each(['same-day-punch', 'schedule-change'] as const)('reopens when relevant %s evidence changes', async variant => {
  const { t, find, review, punch, scheduleId } = await setup();
  await review();
  if (variant === 'same-day-punch') await punch('clock_in', `${date}T07:01:00`);
  else await t.run(ctx => ctx.db.patch(scheduleId, { endTime: '15:30' }));
  expect(await find()).toMatchObject({ status: 'open', review_note: null, reviewed_at: null });
});

it.each(['14:00:00', '14:00:01'])('keeps the 16-hour horizon inclusive for next-day %s evidence', async time => {
  const { find, review, punch } = await setup('22:00');
  await review();
  vi.setSystemTime(new Date(`${nextDate}T21:00:00Z`));
  await punch('clock_in', `${nextDate}T${time}`);
  expect(await find()).toMatchObject({ status: time === '14:00:00' ? 'open' : 'reviewed' });
});

it('reopens for a plausible overnight exit after a competing next-day entry', async () => {
  const { admin, find, punch } = await setup('22:00');
  await punch('clock_in', `${nextDate}T01:00:00`);
  // Refresh after the relevant entry, then review the still-unclosed source shift.
  const source = await find();
  await admin.mutation(api.shiftExceptions.review, { exceptionKey: source.key, date, type: source.type,
    sourceFingerprint: source.source_fingerprint, status: 'reviewed' });
  expect(await find()).toMatchObject({ status: 'reviewed' });
  await punch('clock_out', `${nextDate}T02:00:00`);
  expect(await find()).toMatchObject({ status: 'open' });
});

it('keeps full-window stale correction checks after an irrelevant next-day scan', async () => {
  const { admin, find, review, punch, workerId, source } = await setup();
  await review();
  vi.setSystemTime(new Date(`${nextDate}T21:00:00Z`));
  await punch('clock_in', `${nextDate}T07:00:00`);
  expect(await find()).toMatchObject({ status: 'reviewed' });
  await expect(admin.mutation(api.attendanceCorrections.create, { requestId: 'stale-exit-draft', date, workerId, action: 'add_clock_out',
    correctedTimestamp: `${date}T15:00:00`, relatedExceptionKey: source.key, sourceFingerprint: source.source_fingerprint,
    reason: 'Old draft' })).rejects.toThrow('source exception changed');
});

it('accepts an unchanged legacy full-window review', async () => {
  const { t, find, source } = await setup();
  await t.run(ctx => ctx.db.insert('exceptionReviews', { exceptionKey: source.key, date, type: source.type,
    sourceFingerprint: source.source_fingerprint, status: 'reviewed', note: 'Reviewed before deploy', reviewedAt: date, updatedAt: date }));
  expect(await find()).toMatchObject({ status: 'reviewed', review_note: 'Reviewed before deploy' });
});
