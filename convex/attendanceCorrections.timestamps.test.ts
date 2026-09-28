/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.ts');
async function setup() {
  const t = convexTest(schema, modules);
  const { userId, workerId } = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'admin@example.com' });
    await ctx.db.insert('portalMembers', { userId, role: 'admin', active: true, createdAt: '2026-09-01T00:00:00Z' });
    const workerId = await ctx.db.insert('workers', { name: 'Worker', department: 'Operations', active: true, enrolledAt: '2026-09-01T00:00:00Z' });
    return { userId, workerId };
  });
  return { t, admin: t.withIdentity({ subject: userId }), args: { date: '2026-09-01', workerId, action: 'add_clock_in' as const, reason: 'Missed scan' } };
}

describe('correction timestamp integrity', () => {
  it.each([
    '2026-09-01T99:99:99', '2026-09-01T24:00:00', '2026-09-01T06:60:00',
    '2026-09-01T06:00:60', '2026-09-01', '2026-09-01garbage',
    '2026-02-30T06:00:00', '2026-09-01T06:00:00+99:00', '2026-09-01T06:00:00Zextra',
  ])('rejects malformed timestamp %s before inserting a correction', async correctedTimestamp => {
    const { t, admin, args } = await setup();
    await expect(admin.mutation(api.attendanceCorrections.create, { ...args, correctedTimestamp })).rejects.toThrow('valid ISO date and time');
    expect(await t.run(ctx => ctx.db.query('attendanceCorrections').collect())).toHaveLength(0);
  });

  it.each([
    '2026-09-01T06:00:00', '2026-09-01 06:00:00', '2026-09-01T06:00:00.123456',
    '2026-09-01T06:00:00-05:00', '2026-09-01T06:00:00-0500',
    '2026-09-02T01:00:00.123456Z', '2026-09-02 01:00:00Z',
  ])('accepts valid timestamp %s on its factory date and preserves precision', async correctedTimestamp => {
    const { t, admin, args } = await setup();
    const { id } = await admin.mutation(api.attendanceCorrections.create, { ...args, correctedTimestamp: ` ${correctedTimestamp} ` });
    expect(await t.run(ctx => ctx.db.get(id))).toMatchObject({ correctedTimestamp, date: args.date });
  });

  it.each(['2026-09-02T06:00:00', '2026-09-01T01:00:00Z'])('rejects timestamp %s outside the factory correction date', async correctedTimestamp => {
    const { t, admin, args } = await setup();
    await expect(admin.mutation(api.attendanceCorrections.create, { ...args, correctedTimestamp })).rejects.toThrow('must be on the correction date');
    expect(await t.run(ctx => ctx.db.query('attendanceCorrections').collect())).toHaveLength(0);
  });

  it('validates added clock-outs and still permits void corrections without a timestamp', async () => {
    const { t, admin, args } = await setup();
    await expect(admin.mutation(api.attendanceCorrections.create, { ...args, action: 'add_clock_out', correctedTimestamp: '2026-09-01T99:99:99' })).rejects.toThrow('valid ISO date and time');
    const originalAttendanceId = await t.run(ctx => ctx.db.insert('attendance', { workerId: args.workerId, eventType: 'clock_in', timestamp: '2026-09-01T06:00:00', synced: true }));
    await expect(admin.mutation(api.attendanceCorrections.create, { ...args, action: 'void_event', originalAttendanceId })).resolves.toMatchObject({ id: expect.any(String) });
  });
});
