/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';
const modules = import.meta.glob('./**/*.ts');

async function setup() {
  const t = convexTest(schema, modules);
  const { userId, workerId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert('users', { email: 'admin@example.com' });
    await ctx.db.insert('portalMembers', { userId, role: 'admin', active: true, createdAt: '2026-09-01' });
    const workerId = await ctx.db.insert('workers', { name: 'Worker', department: 'Operations', active: true, enrolledAt: '2026-09-01' });
    return { userId, workerId };
  });
  return { t, admin: t.withIdentity({ subject: userId }), args: {
    requestId: 'retry-123', date: '2026-09-01', workerId, action: 'add_clock_in' as const,
    correctedTimestamp: '2026-09-01T08:00:00', reason: 'Missed scan', supervisorName: 'Supervisor',
  } };
}

describe('attendance correction request identity', () => {
  it('returns the original result after a lost response without duplicating effective attendance', async () => {
    const { admin, args } = await setup();
    const first = await admin.mutation(api.attendanceCorrections.create, args);
    expect(await admin.mutation(api.attendanceCorrections.create, { ...args, reason: '  Missed scan  ', correctedTimestamp: `  ${args.correctedTimestamp}  ` })).toEqual(first);
    expect(await admin.query(api.attendanceCorrections.list, { date: args.date })).toHaveLength(1);
    expect(await admin.query(api.attendance.list, { date: args.date })).toHaveLength(1);
  });

  it.each(['date', 'workerId', 'action', 'correctedTimestamp', 'relatedExceptionKey', 'reason', 'supervisorName'] as const)('rejects changed %s with the same key', async (field) => {
    const { admin, args } = await setup();
    await admin.mutation(api.attendanceCorrections.create, args);
    const otherWorkerId = await admin.run((ctx) => ctx.db.insert('workers', { name: 'Other worker', department: 'Operations', active: true, enrolledAt: '2026-09-01' }));
    const changed = { ...args, [field]: field === 'action' ? 'add_clock_out' : field === 'workerId' ? otherWorkerId : 'different' };
    await expect(admin.mutation(api.attendanceCorrections.create, changed)).rejects.toThrow('different details');
    expect(await admin.query(api.attendanceCorrections.list, { date: args.date })).toHaveLength(1);
  });

  it('preserves legacy requests without an ID and allows distinct IDs', async () => {
    const { admin, args } = await setup();
    const first = await admin.mutation(api.attendanceCorrections.create, args);
    expect((await admin.mutation(api.attendanceCorrections.create, { ...args, requestId: 'other' })).id).not.toEqual(first.id);
    await admin.mutation(api.attendanceCorrections.create, { ...args, requestId: undefined });
    expect(await admin.query(api.attendanceCorrections.list, { date: args.date })).toHaveLength(3);
  });

  it('still requires authorization for a retry', async () => {
    const { t, admin, args } = await setup();
    await admin.mutation(api.attendanceCorrections.create, args);
    await expect(t.mutation(api.attendanceCorrections.create, args)).rejects.toThrow('Unauthorized');
  });

  it('deduplicates voids, too', async () => {
    const { admin, args } = await setup();
    const originalAttendanceId = await admin.run((ctx) => ctx.db.insert('attendance', {
      workerId: args.workerId, eventType: 'clock_in', timestamp: args.correctedTimestamp, synced: true,
    }));
    const request = { ...args, action: 'void_event' as const, correctedTimestamp: undefined, originalAttendanceId };
    const first = await admin.mutation(api.attendanceCorrections.create, request);
    expect(await admin.mutation(api.attendanceCorrections.create, request)).toEqual(first);
    expect(await admin.query(api.attendanceCorrections.list, { date: args.date })).toHaveLength(1);
  });
});
