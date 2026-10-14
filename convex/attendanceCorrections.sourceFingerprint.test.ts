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

it.each(['new-episode', 'same-time-replacement', 'schedule-change', 'correction-replacement'] as const)('rejects correction drafts after %s', async variant => {
  const { t, actor, current, source, sourceFingerprint, workerId, attendanceId, scheduleId } = await setup();
  const request = { requestId: 'old-draft', date, workerId, action: 'add_clock_out' as const,
    correctedTimestamp: `${date}T17:00:00`, relatedExceptionKey: source.key, sourceFingerprint, reason: 'Verified departure' };
  await t.run(async ctx => {
    if (variant === 'new-episode') {
      await ctx.db.insert('attendance', { workerId, eventType: 'clock_out', timestamp: `${date}T17:00:00`, synced: true });
      await ctx.db.insert('attendance', { workerId, eventType: 'clock_in', timestamp: `${date}T18:00:00`, synced: true });
    } else if (variant === 'schedule-change') {
      await ctx.db.patch(scheduleId, { endTime: '17:30' });
    } else {
      await ctx.db.delete(attendanceId);
      if (variant === 'correction-replacement') await ctx.db.insert('attendanceCorrections', {
        date, workerId, action: 'add_clock_in', eventType: 'clock_in', correctedTimestamp: `${date}T08:00:00`,
        reason: 'Replacement evidence', createdAt: date, updatedAt: date,
      });
      else await ctx.db.insert('attendance', { workerId, eventType: 'clock_in', timestamp: `${date}T08:00:00`, synced: true });
    }
  });
  const replacement = await current();
  expect(replacement.key).toBe(source.key);
  if (variant === 'same-time-replacement' || variant === 'correction-replacement') expect(replacement).toMatchObject({ first_seen: source.first_seen, last_seen: source.last_seen, event_count: source.event_count });
  await expect(actor.mutation(api.attendanceCorrections.create, request)).rejects.toThrow('source exception changed');
  expect((await t.run(ctx => ctx.db.query('attendanceCorrections').collect())).filter(row => row.action === 'add_clock_out')).toEqual([]);
});

it('refuses a first source-linked commit without a fingerprint, but replays a legacy committed receipt', async () => {
  const { t, actor, source, workerId } = await setup();
  const request = { requestId: 'legacy-committed', date, workerId, action: 'add_clock_out' as const,
    relatedExceptionKey: source.key, correctedTimestamp: `${date}T17:00:00`, reason: 'Verified departure' };
  await expect(actor.mutation(api.attendanceCorrections.create, request)).rejects.toThrow('source exception changed');
  const id = await t.run(ctx => ctx.db.insert('attendanceCorrections', {
    ...request, eventType: 'clock_out', createdAt: date, updatedAt: date,
  }));
  expect(await actor.mutation(api.attendanceCorrections.create, request)).toEqual({ id, createdAt: date });
});
