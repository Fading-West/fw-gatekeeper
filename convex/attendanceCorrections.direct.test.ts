/// <reference types="vite/client" />

import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';
import { buildHoursExportRows } from '../src/lib/attendance-hours';

// Direct corrections from the Activity Log: no relatedExceptionKey and no
// schedule or generated exception behind them.
const modules = import.meta.glob('./**/*.ts');
const date = '2026-09-14';

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const adminId = await ctx.db.insert('users', { email: 'admin@example.com' });
    const enrollmentId = await ctx.db.insert('users', { email: 'enrollment@example.com' });
    const viewerId = await ctx.db.insert('users', { email: 'viewer@example.com' });
    for (const [userId, role] of [[adminId, 'admin'], [enrollmentId, 'enrollment'], [viewerId, 'viewer']] as const) {
      await ctx.db.insert('portalMembers', { userId, role, active: true, createdAt: date });
    }
    // No schedules exist, so no missing_clock_out exception is ever raised.
    const workerId = await ctx.db.insert('workers', { name: 'Unscheduled Worker', department: 'Yard', active: true, enrolledAt: date });
    const rawId = await ctx.db.insert('attendance', { workerId, eventType: 'clock_in', timestamp: `${date}T08:00:00`, synced: true });
    return { adminId, enrollmentId, viewerId, workerId, rawId };
  });
  return {
    t, ...ids,
    admin: t.withIdentity({ subject: ids.adminId }),
    enrollment: t.withIdentity({ subject: ids.enrollmentId }),
    viewer: t.withIdentity({ subject: ids.viewerId }),
  };
}

describe('direct attendance corrections', () => {
  it('adds a missing clock-out for an unscheduled worker and fixes the hours export', async () => {
    const { enrollment, admin, workerId, enrollmentId } = await setup();
    const before = await admin.query(api.attendance.list, { date });
    expect(buildHoursExportRows(before, [], date)).toMatchObject([{ hours: '0.00', note: 'still clocked in' }]);
    expect((await admin.query(api.shiftExceptions.summary, { date })).exceptions.filter((e: { type: string }) => e.type === 'missing_clock_out')).toHaveLength(0);

    await enrollment.mutation(api.attendanceCorrections.create, {
      requestId: 'direct-add-1', date, workerId, action: 'add_clock_out', correctedTimestamp: `${date}T17:05:00`, reason: 'Forgot to clock out; foreman confirmed',
    });

    const after = await admin.query(api.attendance.list, { date });
    expect(after.map((event: { event_type: string; source: string }) => [event.event_type, event.source])).toEqual([['clock_out', 'correction'], ['clock_in', 'kiosk']]);
    const [row] = buildHoursExportRows(after, [], date);
    expect(row).toMatchObject({ hours: '9.08', firstIn: `${date}T08:00:00`, lastOut: `${date}T17:05:00`, note: '' });
    expect(await admin.query(api.attendanceCorrections.list, { date })).toMatchObject([{
      action: 'add_clock_out', related_exception_key: null, actor_user_id: enrollmentId, actor_name: 'enrollment@example.com',
    }]);
  });

  it('voids a raw row with no exception, keeps the raw row, and restores it on reversal', async () => {
    const { t, admin, enrollment, workerId, rawId, adminId } = await setup();
    const voided = await admin.mutation(api.attendanceCorrections.create, {
      requestId: 'direct-void-1', date, workerId, action: 'void_event', originalAttendanceId: rawId, reason: 'Scan credited to the wrong worker',
    });
    expect(await admin.query(api.attendance.list, { date })).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.get(rawId))).toMatchObject({ timestamp: `${date}T08:00:00` });
    expect(await admin.query(api.attendance.list, { date, includeCorrections: false })).toHaveLength(1);
    const [history] = await admin.query(api.attendanceCorrections.list, { date });
    expect(history).toMatchObject({ id: voided.id, related_exception_key: null, original_attendance_id: rawId, actor_user_id: adminId, worker_name: 'Unscheduled Worker' });
    expect(await t.run((ctx) => ctx.db.get(voided.id))).not.toHaveProperty('relatedExceptionKey');

    await enrollment.mutation(api.attendanceCorrections.reverse, { correctionId: voided.id, requestId: 'reverse-direct-void-1', reason: 'Scan was valid after all' });
    expect((await admin.query(api.attendance.list, { date })).map((event: { id: string }) => event.id)).toEqual([rawId]);
  });

  it('refuses a concurrent second void with a ConvexError, while the same request stays idempotent', async () => {
    const { admin, enrollment, workerId, rawId } = await setup();
    const input = { date, workerId, action: 'void_event' as const, originalAttendanceId: rawId, reason: 'Duplicate scan' };
    const [first, retry] = await Promise.all([
      admin.mutation(api.attendanceCorrections.create, { ...input, requestId: 'void-a' }),
      admin.mutation(api.attendanceCorrections.create, { ...input, requestId: 'void-a' }),
    ]);
    expect(retry).toEqual(first);
    await expect(enrollment.mutation(api.attendanceCorrections.create, { ...input, requestId: 'void-b' })).rejects.toThrow('already has an active void');
  });

  it('rejects viewers and empty reasons', async () => {
    const { viewer, admin, workerId, rawId } = await setup();
    await expect(viewer.mutation(api.attendanceCorrections.create, {
      date, workerId, action: 'void_event', originalAttendanceId: rawId, reason: 'Viewer attempt',
    })).rejects.toThrow();
    await expect(admin.mutation(api.attendanceCorrections.create, {
      date, workerId, action: 'void_event', originalAttendanceId: rawId, reason: '   ',
    })).rejects.toThrow('Correction reason is required.');
    expect(await admin.query(api.attendanceCorrections.list, { date })).toHaveLength(0);
  });

  it('rejects an added time that falls on another factory date', async () => {
    const { admin, workerId } = await setup();
    await expect(admin.mutation(api.attendanceCorrections.create, {
      date, workerId, action: 'add_clock_out', correctedTimestamp: '2026-09-15T01:00:00', reason: 'Wrong day',
    })).rejects.toThrow('correctedTimestamp must be on the correction date.');
  });
});
