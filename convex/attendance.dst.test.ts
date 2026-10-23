/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api, internal } from './_generated/api';
import schema from './schema';
import { isValidAttendanceTimestamp } from './attendanceValidation';

const modules = import.meta.glob('./**/*.ts');

describe('attendance DST timestamp integrity', () => {
  it.each(['2026-03-08T02:00:00', '2026-03-08 02:30:00.123456', '2026-03-08T02:59:59'])('rejects nonexistent factory wall time %s', timestamp => {
    expect(isValidAttendanceTimestamp(timestamp)).toBe(false);
  });

  it.each(['2026-03-08T01:59:59', '2026-03-08T03:00:00', '2026-03-08T02:30:00Z', '2026-03-08T02:30:00-06:00', '2026-11-01T01:30:00'])('preserves valid instant %s', timestamp => {
    expect(isValidAttendanceTimestamp(timestamp)).toBe(true);
  });

  it('rolls back a batch containing a nonexistent wall time and rejects manual corrections', async () => {
    const t = convexTest(schema, modules);
    const { userId, workerId } = await t.run(async ctx => {
      const userId = await ctx.db.insert('users', { email: 'admin@example.com' });
      await ctx.db.insert('portalMembers', { userId, role: 'admin', active: true, createdAt: '2026-01-01T00:00:00Z' });
      const workerId = await ctx.db.insert('workers', { name: 'Worker', department: 'Operations', active: true, enrolledAt: '2026-01-01T00:00:00Z' });
      return { userId, workerId };
    });
    const event = { workerId, eventType: 'clock_in', timestamp: '2026-03-08T01:30:00', kioskId: 'entry-1' };
    await expect(t.mutation(internal.attendance.bulkCreateFromHttp, { events: [event, { ...event, timestamp: '2026-03-08T02:30:00' }] })).rejects.toThrow('timestamp');
    expect(await t.run(ctx => ctx.db.query('attendance').collect())).toHaveLength(0);
    await expect(t.withIdentity({ subject: userId }).mutation(api.attendanceCorrections.create, {
      date: '2026-03-08', workerId, action: 'add_clock_in', reason: 'Missed scan', correctedTimestamp: '2026-03-08T02:30:00',
    })).rejects.toThrow('valid ISO date and time');
    expect(await t.run(ctx => ctx.db.query('attendanceCorrections').collect())).toHaveLength(0);
  });
});
