/// <reference types="vite/client" />

import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.ts');
const date = '2026-09-01';

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const adminId = await ctx.db.insert('users', { email: 'admin@example.com' });
    const enrollmentId = await ctx.db.insert('users', { email: 'enrollment@example.com' });
    const viewerId = await ctx.db.insert('users', { email: 'viewer@example.com' });
    for (const [userId, role] of [[adminId, 'admin'], [enrollmentId, 'enrollment'], [viewerId, 'viewer']] as const) {
      await ctx.db.insert('portalMembers', { userId, role, active: true, createdAt: date });
    }
    const workerId = await ctx.db.insert('workers', { name: 'Worker', department: 'Operations', active: true, enrolledAt: date });
    const rawId = await ctx.db.insert('attendance', { workerId, eventType: 'clock_in', timestamp: '2026-09-01T08:00:00', synced: true });
    return { adminId, enrollmentId, viewerId, workerId, rawId };
  });
  return {
    t, ...ids,
    admin: t.withIdentity({ subject: ids.adminId }),
    enrollment: t.withIdentity({ subject: ids.enrollmentId }),
    viewer: t.withIdentity({ subject: ids.viewerId }),
  };
}

describe('attendance correction reversal', () => {
  it('removes a reversed addition from effective attendance and retains both audit records', async () => {
    const { t, admin, enrollment, workerId, adminId, enrollmentId } = await setup();
    const added = await admin.mutation(api.attendanceCorrections.create, {
      date, workerId, action: 'add_clock_out', correctedTimestamp: '2026-09-01T17:00:00', reason: 'Missed scan',
    });
    expect(await admin.query(api.attendance.list, { date })).toHaveLength(2);
    const reversed = await enrollment.mutation(api.attendanceCorrections.reverse, {
      correctionId: added.id, requestId: 'reverse-add-1', reason: 'Kiosk record found',
    });
    expect(await admin.query(api.attendance.list, { date })).toHaveLength(1);
    expect(await admin.query(api.attendanceCorrections.list, { date })).toMatchObject([{
      id: added.id, actor_user_id: adminId, reversal_id: reversed.id,
      reversal_reason: 'Kiosk record found', reversed_by_user_id: enrollmentId,
    }]);
    expect(await t.run((ctx) => ctx.db.get(added.id))).toMatchObject({ reason: 'Missed scan', actorUserId: adminId });
  });

  it('restores a raw event only after its last active void is reversed', async () => {
    const { admin, workerId, rawId } = await setup();
    const args = { date, workerId, action: 'void_event' as const, originalAttendanceId: rawId, reason: 'Duplicate' };
    const first = await admin.mutation(api.attendanceCorrections.create, { ...args, requestId: 'void-1' });
    const second = await admin.mutation(api.attendanceCorrections.create, { ...args, requestId: 'void-2' });
    expect(await admin.query(api.attendance.list, { date })).toHaveLength(0);
    await admin.mutation(api.attendanceCorrections.reverse, { correctionId: first.id, requestId: 'reverse-void-1', reason: 'First void invalid' });
    expect(await admin.query(api.attendance.list, { date })).toHaveLength(0);
    await admin.mutation(api.attendanceCorrections.reverse, { correctionId: second.id, requestId: 'reverse-void-2', reason: 'Second void invalid' });
    expect(await admin.query(api.attendance.list, { date })).toMatchObject([{ id: rawId, source: 'kiosk' }]);
  });

  it('deduplicates retries and rejects conflicting or concurrent reversals', async () => {
    const { t, admin, enrollment, workerId } = await setup();
    const correction = await admin.mutation(api.attendanceCorrections.create, { date, workerId, action: 'add_clock_in', correctedTimestamp: '2026-09-01T07:00:00', reason: 'Early arrival' });
    const request = { correctionId: correction.id, requestId: 'stable-reversal', reason: 'Wrong worker' };
    const first = await admin.mutation(api.attendanceCorrections.reverse, request);
    await expect(admin.mutation(api.attendanceCorrections.reverse, { correctionId: first.id as unknown as Id<'attendanceCorrections'>, requestId: 'reverse-a-reversal', reason: 'No' })).rejects.toThrow();
    expect(await admin.mutation(api.attendanceCorrections.reverse, { ...request, reason: ' Wrong worker ' })).toEqual(first);
    await expect(admin.mutation(api.attendanceCorrections.reverse, { ...request, reason: 'Different' })).rejects.toThrow('different details');
    await expect(enrollment.mutation(api.attendanceCorrections.reverse, { ...request, requestId: 'another' })).rejects.toThrow('already been reversed');
    expect(await t.run((ctx) => ctx.db.query('attendanceCorrectionReversals').withIndex('by_correctionId', (q) => q.eq('correctionId', correction.id)).collect())).toHaveLength(1);
    const other = await admin.mutation(api.attendanceCorrections.create, { date, workerId, action: 'add_clock_out', correctedTimestamp: '2026-09-01T18:00:00', reason: 'Late departure' });
    const simultaneous = await Promise.allSettled([
      admin.mutation(api.attendanceCorrections.reverse, { correctionId: other.id, requestId: 'concurrent-1', reason: 'Incorrect' }),
      enrollment.mutation(api.attendanceCorrections.reverse, { correctionId: other.id, requestId: 'concurrent-2', reason: 'Incorrect' }),
    ]);
    expect(simultaneous.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.query('attendanceCorrectionReversals').withIndex('by_correctionId', (q) => q.eq('correctionId', other.id)).collect())).toHaveLength(1);
  });

  it('rejects unauthenticated and viewer mutations and derives actors from auth', async () => {
    const { t, admin, viewer, workerId, adminId, rawId } = await setup();
    const correction = await admin.mutation(api.attendanceCorrections.create, { date, workerId, action: 'void_event', originalAttendanceId: rawId, reason: 'Duplicate' });
    const request = { correctionId: correction.id, requestId: 'auth-test', reason: 'Wrong void' };
    await expect(t.mutation(api.attendanceCorrections.reverse, request)).rejects.toThrow('Unauthorized');
    await expect(viewer.mutation(api.attendanceCorrections.reverse, request)).rejects.toThrow('Insufficient permissions');
    await expect(admin.mutation(api.attendanceCorrections.reverse, { ...request, actorUserId: 'spoofed' } as typeof request)).rejects.toThrow();
    const result = await admin.mutation(api.attendanceCorrections.reverse, request);
    expect(await t.run((ctx) => ctx.db.get(result.id))).toMatchObject({ actorUserId: adminId });
  });
});
