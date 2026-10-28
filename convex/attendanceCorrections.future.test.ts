/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';

// Server-side guard for corrections that record attendance that has not
// happened yet (direct API callers and stale tabs skip the client check).
const modules = import.meta.glob('./**/*.ts');
const date = '2026-09-01';
const now = '2026-09-01T15:30:00Z'; // 10:30 factory time (CDT)

async function setup() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now));
  const t = convexTest(schema, modules);
  const { userId, workerId } = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'admin@example.com' });
    await ctx.db.insert('portalMembers', { userId, role: 'admin', active: true, createdAt: date });
    const workerId = await ctx.db.insert('workers', { name: 'Worker', department: 'Operations', active: true, enrolledAt: date });
    await ctx.db.insert('attendance', { workerId, eventType: 'clock_in', timestamp: `${date}T07:55:00`, synced: true });
    return { userId, workerId };
  });
  const corrections = () => t.run(ctx => ctx.db.query('attendanceCorrections').collect());
  return { t, corrections, admin: t.withIdentity({ subject: userId }), args: { date, workerId, action: 'add_clock_out' as const, reason: 'Missed scan' } };
}

afterEach(() => vi.useRealTimers());

describe('future correction timestamps', () => {
  it.each([
    [date, `${date}T17:30:00`],
    [date, `${date}T15:31:01Z`],
    ['2027-09-01', '2027-09-01T08:00:00'],
  ])('rejects %s %s before inserting a correction', async (correctionDate, correctedTimestamp) => {
    const { admin, args, corrections } = await setup();
    await expect(admin.mutation(api.attendanceCorrections.create, { ...args, date: correctionDate, correctedTimestamp }))
      .rejects.toMatchObject({ data: { code: 'INVALID_CORRECTION_TIMESTAMP', message: expect.stringContaining('already happened') } });
    expect(await corrections()).toHaveLength(0);
  });

  it.each([`${date}T10:00:00`, `${date}T10:31:00`, `${date}T15:30:00Z`])('accepts %s that already happened (or is within clock-skew tolerance)', async correctedTimestamp => {
    const { admin, args, corrections } = await setup();
    await admin.mutation(api.attendanceCorrections.create, { ...args, correctedTimestamp });
    expect(await corrections()).toMatchObject([{ correctedTimestamp, date }]);
  });

  it('still replays a committed receipt by requestId', async () => {
    const { admin, args, corrections } = await setup();
    vi.setSystemTime(new Date('2026-09-01T23:00:00Z'));
    const request = { ...args, requestId: 'future-replay-1', correctedTimestamp: `${date}T17:30:00` };
    const receipt = await admin.mutation(api.attendanceCorrections.create, request);
    vi.setSystemTime(new Date(now));
    await expect(admin.mutation(api.attendanceCorrections.create, request)).resolves.toEqual(receipt);
    expect(await corrections()).toHaveLength(1);
  });
});
