/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.ts');
const date = '2026-09-01';
async function fixture(startTime = '08:00', endTime = '17:00') {
  const t = convexTest(schema, modules);
  const ids = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'supervisor@example.com' });
    await ctx.db.insert('portalMembers', { userId, role: 'admin', active: true, createdAt: `${date}T00:00:00Z` });
    const workerId = await ctx.db.insert('workers', { name: 'Example', department: 'Assembly', active: true, enrolledAt: `${date}T00:00:00Z`, faceEncoding: Array(512).fill(0.1) });
    await ctx.db.insert('schedules', { name: 'Shift', department: 'Assembly', days: '[0,1,2,3,4,5,6]', startTime, endTime, active: true, createdAt: `${date}T00:00:00Z` });
    return { userId, workerId };
  });
  return { t, admin: t.withIdentity({ subject: ids.userId }), workerId: ids.workerId };
}

describe('daily attendance and live coverage', () => {
  it('keeps late attendance in the signed closeout after clock-out without changing live occupancy', async () => {
    const { t, admin, workerId } = await fixture();
    await t.run(ctx => ctx.db.insert('attendance', { workerId, eventType: 'clock_in', timestamp: `${date}T09:00:00`, synced: true }));
    expect((await admin.query(api.shiftBriefing.summary, { date })).summary).toMatchObject({ present: 1, late: 1 });
    await t.run(ctx => ctx.db.insert('attendance', { workerId, eventType: 'clock_out', timestamp: `${date}T17:00:00`, synced: true }));
    const briefing = await admin.query(api.shiftBriefing.summary, { date });
    expect(briefing.summary).toMatchObject({ expected: 1, present: 0, late: 0, missing: 0, clocked_out: 1 });
    expect(briefing.workers[0].status).toBe('clocked_out');
    const closeout = await admin.query(api.shiftCloseouts.get, { date });
    expect(closeout.summary).toMatchObject({ expected: 1, present: 1, late: 1, missing: 0 });
    expect(closeout.closeout_draft.source_counts).toMatchObject({ present: 1, late: 1 });
    expect(closeout.suggested_note).toContain('1 present, 1 late');
    const saved = await admin.mutation(api.shiftCloseouts.save, { date, action: 'complete', notes: 'Reviewed', acknowledgedBlockers: true, blockerEvidence: closeout.blocker_evidence });
    expect((await admin.query(api.shiftCloseouts.get, { date })).closeout?.snapshot).toMatchObject({ present: 1, late: 1 });
    const history = await t.run(ctx => ctx.db.query('shiftCloseoutHistory').withIndex('by_closeout', q => q.eq('closeoutId', saved.id)).collect());
    expect(history[0].after).toMatchObject({ present: 1, late: 1 });
  });

  it('counts distinct attendees and their first arrival after repeated scans', async () => {
    const { t, admin, workerId } = await fixture();
    await t.run(async ctx => {
      for (const [time, eventType] of [['07:55', 'clock_in'], ['12:00', 'clock_out'], ['13:00', 'clock_in'], ['17:00', 'clock_out']]) {
        await ctx.db.insert('attendance', { workerId, eventType, timestamp: `${date}T${time}:00`, synced: true });
      }
      await ctx.db.insert('workers', { name: 'Absent', department: 'Assembly', active: true, enrolledAt: `${date}T00:00:00Z` });
    });
    expect((await admin.query(api.shiftCloseouts.get, { date })).summary).toMatchObject({ expected: 2, present: 1, late: 0, missing: 1 });
  });

  it.each([['22:00', '06:00'], ['08:00', '08:00'], ['25:00', '26:00'], ['8:00', '17:00'], ['08:00junk', '17:00']])(
    'excludes unsupported %s–%s schedules and retains a configuration blocker after exception review', async (startTime, endTime) => {
      const { t, admin, workerId } = await fixture(startTime, endTime);
      await t.run(async ctx => {
        // An invalid department assignment must not fall back to a valid default.
        await ctx.db.insert('schedules', { name: 'Default', days: '[0,1,2,3,4,5,6]', startTime: '08:00', endTime: '17:00', active: true, createdAt: `${date}T00:00:00Z` });
        await ctx.db.insert('exceptionReviews', { exceptionKey: `${date}:unsupported_schedule:${workerId}`, date, type: 'unsupported_schedule', status: 'reviewed', updatedAt: `${date}T00:00:00Z` });
      });
      for (const scanned of [false, true]) {
        if (scanned) await t.run(ctx => ctx.db.insert('attendance', { workerId, eventType: 'clock_in', timestamp: `${date}T09:00:00`, synced: true }));
        const briefing = await admin.query(api.shiftBriefing.summary, { date });
        expect(briefing.summary).toMatchObject({ expected: 0, present: 0, late: 0, missing: 0 });
        expect(briefing.workers).toEqual([]);
        expect(briefing.departments).toEqual([]);
        expect(briefing.coverage_unavailable).toBe(1);
        expect(briefing.shift_trust_brief.readiness_status).toBe('blocked');
        expect(briefing.shift_trust_brief.summary_sentence).toContain('Coverage is unavailable for 1 worker');
        expect(briefing.shift_trust_brief.readiness_blockers).toContainEqual(expect.objectContaining({ id: 'schedule:unsupported' }));
        expect(briefing.action_items.some(item => item.id.startsWith('coverage:'))).toBe(false);
        const closeout = await admin.query(api.shiftCloseouts.get, { date });
        expect(closeout.can_complete).toBe(false);
        expect(closeout.blockers).toContainEqual(expect.objectContaining({ id: 'schedule_coverage', count: 1 }));
        await expect(admin.mutation(api.shiftCloseouts.save, { date, action: 'complete' })).rejects.toThrow('acknowledgement note');
      }
    },
  );
});
