/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { expect, it } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';
const modules = import.meta.glob('./**/*.ts');
const date = '2026-10-02';
it.each(['admin', 'enrollment', 'viewer'] as const)('keeps identifiers stable through roster changes/removal for %s exports', async role => {
  const t = convexTest(schema, modules);
  const ids = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'synthetic@example.invalid' });
    await ctx.db.insert('portalMembers', { userId, role, active: true, createdAt: date });
    const workerId = await ctx.db.insert('workers', { name: 'Original', employeeId: 'E-1', department: 'Mill', active: true, enrolledAt: date });
    const eventId = await ctx.db.insert('attendance', { workerId, eventType: 'clock_in', timestamp: `${date}T08:00:00`, synced: true });
    const correctionId = await ctx.db.insert('attendanceCorrections', { date, workerId, action: 'add_clock_out', eventType: 'clock_out', correctedTimestamp: `${date}T16:00:00`, reason: 'Missed scan', createdAt: date, updatedAt: date });
    return { userId, workerId, eventId, correctionId };
  });
  const actor = t.withIdentity({ subject: ids.userId });
  const read = () => actor.query(api.attendance.list, { date });
  const identifiers = (rows: Awaited<ReturnType<typeof read>>) => rows.map(row => ({ worker: row.worker_id, event: row.id, correction: row.correction_id }));
  const before = await read();
  expect(before).toMatchObject([
    { worker_id: ids.workerId, id: `correction:${ids.correctionId}`, correction_id: ids.correctionId, worker_employee_id: 'E-1' },
    { worker_id: ids.workerId, id: ids.eventId, correction_id: null, worker_employee_id: 'E-1' },
  ]);
  await t.run(ctx => ctx.db.patch(ids.workerId, { name: 'Renamed', employeeId: 'E-2', active: false }));
  const renamed = await read();
  expect(identifiers(renamed)).toEqual(identifiers(before));
  expect(renamed.map(row => row.worker_name)).toEqual(['Renamed', 'Renamed']);
  expect(renamed.map(row => row.worker_employee_id)).toEqual(['E-2', 'E-2']);
  await t.run(ctx => ctx.db.delete(ids.workerId));
  const removed = await read();
  expect(identifiers(removed)).toEqual(identifiers(before));
  expect(removed.map(row => row.worker_employee_id)).toEqual([null, null]);
});
