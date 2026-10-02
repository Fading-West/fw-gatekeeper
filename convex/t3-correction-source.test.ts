/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.ts');
const date = '2026-09-03';
async function setup() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-04T01:00:00Z'));
  const t = convexTest(schema, modules);
  const ids = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'synthetic-supervisor@example.test' });
    await ctx.db.insert('portalMembers', { userId, role: 'enrollment', active: true, createdAt: date });
    const workerId = await ctx.db.insert('workers', { name: 'Synthetic worker', department: 'Assembly', active: true, enrolledAt: date });
    await ctx.db.insert('schedules', { name: 'Day shift', department: 'Assembly', days: '[4]', startTime: '06:00', endTime: '18:00', active: true, createdAt: date });
    await ctx.db.insert('attendance', { workerId, eventType: 'clock_in', timestamp: `${date}T06:00:00`, synced: true });
    return { userId, workerId };
  });
  const actor = t.withIdentity({ subject: ids.userId });
  const request = { requestId: 'synthetic-missing-out', date, workerId: ids.workerId, action: 'add_clock_out' as const,
    correctedTimestamp: `${date}T18:00:00`, relatedExceptionKey: `${date}:missing_clock_out:${ids.workerId}`, reason: 'Supervisor verified departure' };
  return { t, actor, request, ...ids };
}
afterEach(() => vi.useRealTimers());

describe('correction commits use current exception evidence', () => {
  it('rejects a missing-out draft after the kiosk supplies the actual departure', async () => {
    const { t, actor, request } = await setup();
    expect((await actor.query(api.shiftExceptions.summary, { date })).exceptions.some(row => row.key === request.relatedExceptionKey)).toBe(true);
    await t.run(ctx => ctx.db.insert('attendance', { workerId: request.workerId, eventType: 'clock_out', timestamp: `${date}T18:01:00`, synced: true }));
    await expect(actor.mutation(api.attendanceCorrections.create, request)).rejects.toThrow('source exception changed');
    expect(await t.run(ctx => ctx.db.query('attendanceCorrections').collect())).toEqual([]);
    expect(await actor.query(api.attendance.list, { date })).toHaveLength(2);
  });

  it('keeps committed retries valid after the source disappears and after reversal', async () => {
    const { actor, request } = await setup();
    const first = await actor.mutation(api.attendanceCorrections.create, request);
    expect((await actor.query(api.shiftExceptions.summary, { date })).exceptions.some(row => row.key === request.relatedExceptionKey)).toBe(false);
    expect(await actor.mutation(api.attendanceCorrections.create, request)).toEqual(first);
    await actor.mutation(api.attendanceCorrections.reverse, { correctionId: first.id, requestId: 'synthetic-reversal', reason: 'Departure was later' });
    expect(await actor.mutation(api.attendanceCorrections.create, request)).toEqual(first);
    expect(await actor.query(api.attendanceCorrections.list, { date })).toHaveLength(1);
  });

  it.each(['unknown', 'other-worker', 'other-date', 'wrong-action'] as const)('rejects %s source attribution', async variant => {
    const { t, actor, request } = await setup();
    const other = await t.run(ctx => ctx.db.insert('workers', { name: 'Other synthetic worker', department: 'Assembly', active: true, enrolledAt: date }));
    const changed = variant === 'unknown' ? { ...request, relatedExceptionKey: `${date}:missing_clock_out:unknown` }
      : variant === 'other-worker' ? { ...request, workerId: other }
      : variant === 'other-date' ? { ...request, date: '2026-09-04', correctedTimestamp: '2026-09-04T18:00:00' }
      : { ...request, action: 'add_clock_in' as const };
    await expect(actor.mutation(api.attendanceCorrections.create, changed)).rejects.toThrow('source exception changed');
    expect(await t.run(ctx => ctx.db.query('attendanceCorrections').collect())).toEqual([]);
  });

  it('retains explicit manual corrections and rejects a role-revoked source retry', async () => {
    const { t, actor, request, userId } = await setup();
    await actor.mutation(api.attendanceCorrections.create, { ...request, relatedExceptionKey: undefined });
    await t.run(async ctx => {
      const member = await ctx.db.query('portalMembers').withIndex('by_user', q => q.eq('userId', userId)).unique();
      await ctx.db.patch(member!._id, { role: 'viewer' });
    });
    await expect(actor.mutation(api.attendanceCorrections.create, request)).rejects.toThrow('Insufficient permissions');
  });
});
