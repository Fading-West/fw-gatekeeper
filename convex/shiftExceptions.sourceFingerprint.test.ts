/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';
const modules = import.meta.glob('./**/*.ts');
const date = '2026-09-03';
afterEach(() => vi.useRealTimers());
async function setup() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-04T01:00:00Z'));
  const t = convexTest(schema, modules);
  const ids = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'fingerprint-operator@example.test' });
    await ctx.db.insert('portalMembers', { userId, role: 'enrollment', active: true, createdAt: date });
    const workerId = await ctx.db.insert('workers', { name: 'Worker', department: 'Assembly', active: true, enrolledAt: date });
    const scheduleId = await ctx.db.insert('schedules', { name: 'Day', days: '[4]', startTime: '08:00', endTime: '17:00', active: true, createdAt: date });
    const attendanceId = await ctx.db.insert('attendance', { workerId, eventType: 'clock_in', timestamp: `${date}T08:00:00`, synced: true });
    return { userId, workerId, attendanceId, scheduleId };
  });
  const actor = t.withIdentity({ subject: ids.userId });
  const current = async () => (await actor.query(api.shiftExceptions.summary, { date })).exceptions.find(row => row.type === 'missing_clock_out')!;
  const source = await current();
  const sourceFingerprint = source.source_fingerprint;
  return { t, actor, current, source, sourceFingerprint, ...ids };
}

it.each(['new-episode', 'same-time-replacement'] as const)('rejects review drafts after %s', async variant => {
  const { t, actor, current, source, sourceFingerprint, workerId, attendanceId } = await setup();
  await t.run(async ctx => {
    if (variant === 'new-episode') {
      await ctx.db.insert('attendance', { workerId, eventType: 'clock_out', timestamp: `${date}T17:00:00`, synced: true });
      await ctx.db.insert('attendance', { workerId, eventType: 'clock_in', timestamp: `${date}T18:00:00`, synced: true });
    } else {
      await ctx.db.delete(attendanceId);
      await ctx.db.insert('attendance', { workerId, eventType: 'clock_in', timestamp: `${date}T08:00:00`, synced: true });
    }
  });
  const replacement = await current();
  expect(replacement.key).toBe(source.key);
  if (variant === 'same-time-replacement') expect(replacement).toMatchObject({ first_seen: source.first_seen, last_seen: source.last_seen, event_count: source.event_count });
  await expect(actor.mutation(api.shiftExceptions.review, { exceptionKey: source.key, date, type: source.type,
    sourceFingerprint, status: 'reviewed', note: 'Old incident' })).rejects.toThrow('no longer matches');
  expect(await t.run(ctx => ctx.db.query('exceptionReviews').collect())).toEqual([]);
  expect(await t.run(ctx => ctx.db.query('auditLog').collect())).toEqual([]);
  expect(await current()).toMatchObject({ status: 'open', review_note: null });
});
it.each(['new-episode', 'same-time-replacement', 'schedule-change', 'legacy'] as const)('reopens dispositions when evidence changes: %s', async variant => {
  const { t, actor, current, source, sourceFingerprint, workerId, attendanceId, scheduleId } = await setup();
  if (variant === 'legacy') await t.run(ctx => ctx.db.insert('exceptionReviews', {
    exceptionKey: source.key, date, type: source.type, status: 'ignored', note: 'Unattributable old review', updatedAt: date,
  }));
  else {
    await actor.mutation(api.shiftExceptions.review, { exceptionKey: source.key, date, type: source.type, sourceFingerprint, status: 'ignored', note: 'Old evidence reviewed' });
    expect(await current()).toMatchObject({ status: 'ignored' });
    await t.run(async ctx => {
      if (variant === 'schedule-change') await ctx.db.patch(scheduleId, { endTime: '17:30' });
      else if (variant === 'new-episode') {
        await ctx.db.insert('attendance', { workerId, eventType: 'clock_out', timestamp: `${date}T17:00:00`, synced: true });
        await ctx.db.insert('attendance', { workerId, eventType: 'clock_in', timestamp: `${date}T18:00:00`, synced: true });
      } else {
        await ctx.db.delete(attendanceId);
        await ctx.db.insert('attendance', { workerId, eventType: 'clock_in', timestamp: `${date}T08:00:00`, synced: true });
      }
    });
  }
  expect(await current()).toMatchObject({ status: 'open', review_note: null, reviewed_at: null });
  expect((await actor.query(api.shiftExceptions.summary, { date })).summary.open).toBeGreaterThan(0);
  expect(await t.run(ctx => ctx.db.query('exceptionReviews').collect())).toHaveLength(1);
});

it('requires fresh evidence attribution for missing or forged fingerprints', async () => {
  const { t, actor, source } = await setup();
  const request = { exceptionKey: source.key, date, type: source.type, status: 'reviewed' as const };
  await expect(actor.mutation(api.shiftExceptions.review, request)).rejects.toThrow('no longer matches');
  await expect(actor.mutation(api.shiftExceptions.review, { ...request, sourceFingerprint: 'forged' })).rejects.toThrow('no longer matches');
  expect(await t.run(ctx => ctx.db.query('exceptionReviews').collect())).toEqual([]);
});
