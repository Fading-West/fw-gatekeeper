/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api, internal } from './_generated/api';
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
  const event = { workerId, eventType: 'clock_in', kioskId: 'entry-1', idempotencyKey: 'source-1' };
  return { t, admin: t.withIdentity({ subject: userId }), event };
}

describe('attendance offsets stay inside the daily report window', () => {
  // 2026-09-01 23:30 in Chicago, stored under a date two days later, so no
  // factory day's timestamp scan can ever return it.
  it('rejects an offset whose stored date falls outside its factory day scan', async () => {
    const { t, event } = await setup();
    await expect(t.mutation(internal.attendance.bulkCreateFromHttp, { events: [{ ...event, timestamp: '2026-09-03T00:30:00+20:00' }] })).rejects.toThrow('timestamp');
    expect(await t.run(ctx => ctx.db.query('attendance').collect())).toHaveLength(0);
  });

  it.each([
    ['2026-09-02T09:00:00+14:00', '2026-09-01T19:00:00Z'],
    ['2026-09-01T03:00:00-12:00', '2026-09-01T15:00:00Z'],
  ])('accepts real-world offset %s and reports it on its factory date', async (timestamp, utc) => {
    const { admin, t, event } = await setup();
    expect(await t.mutation(internal.attendance.bulkCreateFromHttp, { events: [{ ...event, timestamp }] })).toEqual({ synced: 1, acknowledged: 1 });
    const rows = await admin.query(api.attendance.list, { date: '2026-09-01' });
    expect(rows.map((row: any) => row.timestamp_utc)).toEqual([utc]);
  });
});
