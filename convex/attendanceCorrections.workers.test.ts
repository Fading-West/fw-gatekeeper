/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.ts');

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert('users', { name: 'Private account name' });
    await ctx.db.insert('portalMembers', { userId, role: 'admin', active: true, createdAt: '2026-09-01' });
    const kioskId = await ctx.db.insert('kiosks', { name: 'Kiosk', type: 'entry', location: 'Gate', active: true });
    const workerId = await ctx.db.insert('workers', { name: 'Worker', department: 'Operations', active: true, enrolledAt: '2026-09-01' });
    const missingWorkerId = await ctx.db.insert('workers', { name: 'Removed', department: 'Operations', active: true, enrolledAt: '2026-09-01' });
    await ctx.db.delete(missingWorkerId);
    return { userId, kioskId, workerId, missingWorkerId };
  });
  return { t, ...ids, admin: t.withIdentity({ subject: ids.userId }), args: {
    date: '2026-09-01', workerId: ids.workerId, action: 'add_clock_in' as const,
    correctedTimestamp: '2026-09-01T08:00:00', reason: 'Missed scan', requestId: 'worker-check',
  } };
}

describe('attendance correction worker identity', () => {
  it.each(['userId', 'kioskId', 'missingWorkerId', 'malformed'] as const)('rejects %s without writing a correction or effective attendance', async (kind) => {
    const fixture = await setup();
    const workerId = (kind === 'malformed' ? 'not-an-id' : fixture[kind]) as Id<'workers'>;
    await expect(fixture.admin.mutation(api.attendanceCorrections.create, { ...fixture.args, workerId })).rejects.toThrow();
    expect(await fixture.t.run((ctx) => ctx.db.query('attendanceCorrections').collect())).toEqual([]);
    expect(await fixture.admin.query(api.attendance.list, { date: fixture.args.date })).toEqual([]);
  });

  it.each([true, false])('allows existing workers with active=%s and preserves retry results after removal', async (active) => {
    const { t, admin, args } = await setup();
    await t.run((ctx) => ctx.db.patch(args.workerId, { active }));
    const first = await admin.mutation(api.attendanceCorrections.create, args);
    expect(await admin.query(api.attendanceCorrections.list, { date: args.date, workerId: args.workerId })).toMatchObject([{ worker_name: 'Worker', worker_department: 'Operations' }]);
    expect(await admin.query(api.attendance.list, { date: args.date })).toHaveLength(1);
    await t.run((ctx) => ctx.db.delete(args.workerId));
    expect(await admin.mutation(api.attendanceCorrections.create, args)).toEqual(first);
    expect(await t.run((ctx) => ctx.db.query('attendanceCorrections').collect())).toHaveLength(1);
  });

  it('rejects non-worker IDs in list filters and does not expose account names from legacy corrections', async () => {
    const { t, admin, args, userId } = await setup();
    await t.run((ctx) => ctx.db.insert('attendanceCorrections', {
      date: args.date, workerId: userId, action: args.action, reason: args.reason,
      correctedTimestamp: args.correctedTimestamp, createdAt: args.date, updatedAt: args.date,
    }));
    await expect(admin.query(api.attendanceCorrections.list, { date: args.date, workerId: userId as unknown as Id<'workers'> })).rejects.toThrow();
    expect(await admin.query(api.attendanceCorrections.list, { date: args.date })).toMatchObject([{ worker_name: '', worker_department: '' }]);
  });
});
