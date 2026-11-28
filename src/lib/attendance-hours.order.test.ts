/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { expect, it } from 'vitest';
import { api } from '../../convex/_generated/api';
import schema from '../../convex/schema';
import { buildHoursExportRows } from './attendance-hours';
import { buildHoursExportCSV } from './attendance-export';

const modules = import.meta.glob('../../convex/**/*.ts');
const date = '2026-09-14';

it.each([false, true])('keeps the API tie order when exporting tied lunch punches (repeated=%s)', async repeated => {
  const t = convexTest(schema, modules);
  const userId = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'hours-order@example.test' });
    await ctx.db.insert('portalMembers', { userId, role: 'admin', active: true, createdAt: date });
    const workerId = await ctx.db.insert('workers', {
      name: 'Worker', department: 'Assembly', active: true, enrolledAt: date,
    });
    await ctx.db.insert('attendance', {
      workerId, eventType: 'clock_in', timestamp: `${date}T08:00:00`, synced: true,
    });
    // IDs need not follow insertion order. Bind this fixture to the actual
    // backend tie breaker so both possible sequences are deterministic.
    const tiedIds = await Promise.all([0, 1].map(() => ctx.db.insert('attendance', {
      workerId, eventType: 'clock_in', timestamp: `${date}T12:00:00`, synced: true,
    })));
    tiedIds.sort((a, b) => String(a).localeCompare(String(b)));
    await ctx.db.patch(tiedIds[0], { eventType: repeated ? 'clock_in' : 'clock_out' });
    await ctx.db.patch(tiedIds[1], { eventType: repeated ? 'clock_out' : 'clock_in' });
    await ctx.db.insert('attendance', {
      workerId, eventType: 'clock_out', timestamp: `${date}T16:00:00`, synced: true,
    });
    return userId;
  });
  const history = await t.withIdentity({ subject: userId }).query(api.attendance.list, { date });
  expect([...history].reverse().map(row => row.event_type)).toEqual(repeated
    ? ['clock_in', 'clock_in', 'clock_out', 'clock_out']
    : ['clock_in', 'clock_out', 'clock_in', 'clock_out']);

  const rows = buildHoursExportRows(history, [], date);
  expect(rows).toMatchObject([{
    hours: repeated ? '' : '8.00', ambiguous: repeated,
    note: repeated ? expect.stringContaining('repeated clock-in') : '',
  }]);
  const csv = buildHoursExportCSV(rows);
  expect(csv.includes('hours withheld')).toBe(repeated);
  expect(csv.includes(',8.00,')).toBe(!repeated);
});
