/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';
const modules = import.meta.glob('./**/*.ts');
const date = '2026-09-03';
async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'synthetic-operator@example.test' });
    await ctx.db.insert('portalMembers', { userId, role: 'enrollment', active: true, createdAt: date });
    const workerId = await ctx.db.insert('workers', { name: 'Synthetic worker', active: true, enrolledAt: date, department: 'Assembly' });
    const attendanceId = await ctx.db.insert('attendance', { workerId, eventType: 'clock_out', timestamp: `${date}T18:00:00`, synced: true });
    return { userId, workerId, attendanceId };
  });
  const actor = t.withIdentity({ subject: ids.userId });
  const input = { exceptionKey: `${date}:scan_sequence:${ids.workerId}:${ids.attendanceId}`, date, type: 'scan_sequence', status: 'reviewed' as const, note: 'Evidence reviewed' };
  return { t, actor, input, ...ids };
}
describe('reviews bind to current exception sources', () => {
  it.each(['unknown', 'date', 'type'] as const)('rejects %s attribution without storing a disposition or audit', async variant => {
    const { t, actor, input } = await setup();
    const invalid = variant === 'unknown' ? { ...input, exceptionKey: `${date}:scan_sequence:missing` }
      : variant === 'date' ? { ...input, date: '2026-09-04' } : { ...input, type: 'missing_arrival' };
    await expect(actor.mutation(api.shiftExceptions.review, invalid)).rejects.toThrow('no longer matches');
    expect(await t.run(ctx => ctx.db.query('exceptionReviews').collect())).toEqual([]);
    expect(await t.run(ctx => ctx.db.query('auditLog').collect())).toEqual([]);
  });
  it('rejects a draft disposition after the actual clock-in resolves its source', async () => {
    const { t, actor, input, workerId } = await setup();
    await t.run(ctx => ctx.db.insert('attendance', { workerId, eventType: 'clock_in', timestamp: `${date}T06:00:00`, synced: true }));
    await expect(actor.mutation(api.shiftExceptions.review, input)).rejects.toThrow('no longer matches');
    expect(await t.run(ctx => ctx.db.query('exceptionReviews').collect())).toEqual([]);
  });
  it('keeps a valid review and reopen audited, but refuses reopening vanished historical evidence', async () => {
    const { t, actor, input, attendanceId, userId } = await setup();
    const first = await actor.mutation(api.shiftExceptions.review, input);
    await actor.mutation(api.shiftExceptions.review, { ...input, status: 'open' });
    const audits = await t.run(ctx => ctx.db.query('auditLog').collect());
    expect(audits).toHaveLength(2);
    expect(audits.every(row => row.actorUserId === userId && row.targetId === first.id)).toBe(true);
    await t.run(ctx => ctx.db.delete(attendanceId));
    await expect(actor.mutation(api.shiftExceptions.review, { ...input, status: 'open' })).rejects.toThrow('no longer matches');
    expect(await t.run(ctx => ctx.db.query('auditLog').collect())).toEqual(audits);
    expect(await t.run(ctx => ctx.db.get(first.id))).toMatchObject({ status: 'open', note: input.note });
  });
  it('rejects impossible dates at the database boundary', async () => {
    const { actor, input } = await setup();
    await expect(actor.mutation(api.shiftExceptions.review, { ...input, date: '2026-02-30' })).rejects.toThrow('valid YYYY-MM-DD');
  });
});
