/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { expect, it } from 'vitest';
import schema from './schema';
import { api, internal } from './_generated/api';
const modules = import.meta.glob('./**/*.ts');
const attempt = { kioskId: 'synthetic-entry', timestamp: '2026-09-14T08:00:00', faceDetected: true, decision: 'accepted', threshold: 0.45, bestScore: 0.8 };
async function setup() {
 const t = convexTest(schema, modules);
 const userId = await t.run(async ctx => {
  const id = await ctx.db.insert('users', { email: 'synthetic-admin@example.test' });
  await ctx.db.insert('portalMembers', { userId: id, role: 'admin', active: true, createdAt: new Date().toISOString() });
  return id;
 });
 return { t, admin: t.withIdentity({ subject: userId }), userId };
}
it('prevents overlapping voids while preserving retries and reversal', async () => {
 const { t, admin } = await setup();
 const workerId = await t.run(ctx => ctx.db.insert('workers', { name: 'Synthetic worker', department: '', active: true, enrolledAt: '2026-09-14' }));
 const originalAttendanceId = await t.run(ctx => ctx.db.insert('attendance', { workerId, timestamp: attempt.timestamp, eventType: 'clock_in', synced: true }));
 const input = { workerId, originalAttendanceId, date: '2026-09-14', action: 'void_event' as const, reason: 'Duplicate scan', requestId: 'void-one' };
 const first = await admin.mutation(api.attendanceCorrections.create, input);
 expect(await admin.mutation(api.attendanceCorrections.create, input)).toEqual(first);
 await expect(admin.mutation(api.attendanceCorrections.create, { ...input, requestId: 'void-two' })).rejects.toThrow('active void');
 await admin.mutation(api.attendanceCorrections.reverse, { correctionId: first.id, requestId: 'reverse-one', reason: 'Scan was valid' });
 expect(await admin.query(api.attendance.list, { date: input.date })).toHaveLength(1);
 await expect(admin.mutation(api.attendanceCorrections.create, { ...input, requestId: 'void-three' })).resolves.toMatchObject({ id: expect.any(String) });
 expect(await t.run(ctx => ctx.db.query('attendance').collect())).toHaveLength(1);
});
