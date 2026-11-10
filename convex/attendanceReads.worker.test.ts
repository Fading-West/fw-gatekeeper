/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { expect, it } from 'vitest';
import schema from './schema';
import { scanAttendanceByTimestamp, shareAttendanceReads } from './attendanceReads';
import { listAttendanceByTimestampRange } from './attendance';
const modules = import.meta.glob('./**/*.ts');
const range = { startTimestamp: '2026-08-31', endTimestamp: '2026-09-03' };

it('worker reads preserve date membership, variants, bounds and empty histories', async () => {
  const t = convexTest(schema, modules);
  await t.run(async ctx => {
    const rows = [
      ['2026-09-01T07:00:00', 'mine'],
      ['2026-09-01T12:01:00.123Z', 'mine'],
      ['2026-09-02T09:00:00+14:00', 'mine'],
      ['2026-09-01T16:00:00-05:00', 'mine'],
      ['2026-08-31', 'mine'], // Included start bound, but a different factory date.
      ['2026-09-03', 'mine'], // Excluded end bound.
      ['2026-09-01T08:00:00', 'other'],
    ];
    for (const [timestamp, workerId] of rows) await ctx.db.insert('attendance', {
      timestamp, workerId, eventType: 'clock_in', synced: true,
    });
    const all = await scanAttendanceByTimestamp(ctx, range);
    const worker = await scanAttendanceByTimestamp(ctx, range, 'mine');
    expect(worker).toEqual(all.filter(row => row.workerId === 'mine'));
    expect(worker.map(row => row.timestamp)).toContain(range.startTimestamp);
    expect(worker.map(row => row.timestamp)).not.toContain(range.endTimestamp);
    expect(await scanAttendanceByTimestamp(ctx, range, 'absent')).toEqual([]);
    const day = await listAttendanceByTimestampRange(ctx, '2026-09-01', 'mine');
    expect(day.map(row => row.chronologicalKey)).toEqual([
      '2026-09-01T12:00:00.', '2026-09-01T12:01:00.123',
      '2026-09-01T19:00:00.', '2026-09-01T21:00:00.',
    ]);
  });
});

it('shared scopes isolate worker/range results and release snapshots before writes', async () => {
  const t = convexTest(schema, modules);
  await t.run(async ctx => {
    for (const workerId of ['one', 'two']) await ctx.db.insert('attendance', {
      workerId, timestamp: '2026-09-01T08:00:00', eventType: 'clock_in', synced: true,
    });
    const endScope = shareAttendanceReads(ctx);
    const endNested = shareAttendanceReads(ctx);
    try {
      const [one, two, all] = await Promise.all([
        scanAttendanceByTimestamp(ctx, range, 'one'),
        scanAttendanceByTimestamp(ctx, range, 'two'),
        scanAttendanceByTimestamp(ctx, range),
      ]);
      expect(one.map(row => row.workerId)).toEqual(['one']);
      expect(two.map(row => row.workerId)).toEqual(['two']);
      expect(all).toHaveLength(2);
      one.pop(); all.reverse(); all.pop();
      endNested(); // Nested cleanup must leave the enclosing scope intact.
      expect(await scanAttendanceByTimestamp(ctx, range, 'one')).toHaveLength(1);
      expect(await scanAttendanceByTimestamp(ctx, range)).toHaveLength(2);
      expect(await scanAttendanceByTimestamp(ctx, {
        startTimestamp: '2026-09-02', endTimestamp: range.endTimestamp,
      }, 'one')).toEqual([]);
    } finally { endScope(); }
    await ctx.db.insert('attendance', {
      workerId: 'one', timestamp: '2026-09-01T09:00:00', eventType: 'clock_out', synced: true,
    });
    const endNext = shareAttendanceReads(ctx);
    try { expect(await scanAttendanceByTimestamp(ctx, range, 'one')).toHaveLength(2); }
    finally { endNext(); }
  });
});
