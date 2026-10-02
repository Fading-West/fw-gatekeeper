/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';
const modules = import.meta.glob('./**/*.ts');
const date = '2026-09-03';
async function setup(kind: 'none' | 'ambiguous' | 'unsupported' | 'unique') {
  const t = convexTest(schema, modules);
  const ids = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'synthetic-assignment@example.test' });
    await ctx.db.insert('portalMembers', { userId, role: 'enrollment', active: true, createdAt: date });
    const workerId = await ctx.db.insert('workers', { name: 'Synthetic assembly worker', department: 'Assembly', active: true, enrolledAt: date, faceEncoding: Array(512).fill(.1) });
    const insert = (name: string, department?: string, startTime = '08:00', endTime = '17:00') => ctx.db.insert('schedules', { name, department, days: '[4]', startTime, endTime, active: true, createdAt: date });
    if (kind === 'none') await insert('Other department', 'Packing');
    if (kind === 'ambiguous') { await insert('Assembly one', 'Assembly'); await insert('Assembly two', 'Assembly', '09:00'); await insert('Fallback'); }
    if (kind === 'unsupported') { await insert('Overnight', 'Assembly', '22:00', '06:00'); await insert('Fallback'); }
    if (kind === 'unique') { await insert('Assembly one', 'Assembly'); await insert('Fallback one'); await insert('Fallback two'); }
    // A raw out-without-in must survive unavailable schedule classification.
    const eventId = await ctx.db.insert('attendance', { workerId: String(workerId), timestamp: `${date}T09:00:00`, eventType: 'clock_out', synced: true });
    return { userId, workerId, eventId };
  });
  return { t, actor: t.withIdentity({ subject: ids.userId }), ...ids };
}
describe('schedule uncertainty preserves attendance evidence', () => {
  it.each(['none', 'ambiguous', 'unsupported'] as const)('reports %s coverage without classifying raw scans against an invented schedule', async kind => {
    const { t, actor, workerId, eventId } = await setup(kind);
    const rawBefore = await t.run(ctx => ctx.db.query('attendance').collect());
    const briefing = await actor.query(api.shiftBriefing.summary, { date });
    expect(briefing.summary.expected).toBe(0);
    expect(briefing.daily_attendance).toEqual({ expected: 0, present: 0, late: 0, missing: 0 });
    expect(briefing.schedule_assignment_warnings).toContainEqual(expect.objectContaining({ worker_id: String(workerId), kind, event_count: 1 }));
    expect(briefing.shift_trust_brief.readiness_blockers).toContainEqual(expect.objectContaining({ category: 'schedule', count: 1 }));
    const exceptions = (await actor.query(api.shiftExceptions.summary, { date })).exceptions;
    expect(exceptions.some(row => ['missing_arrival', 'late_arrival', 'missing_clock_out'].includes(row.type))).toBe(false);
    expect(exceptions).toContainEqual(expect.objectContaining({ type: 'scan_sequence', attendance_id: String(eventId) }));
    const configuration = exceptions.find(row => row.type === (kind === 'none' ? 'unassigned_schedule' : kind === 'ambiguous' ? 'ambiguous_schedule' : 'unsupported_schedule'))!;
    expect(configuration.suggested_resolution).toMatchObject({ action: 'review_only', can_apply: false });
    const closeout = await actor.query(api.shiftCloseouts.get, { date });
    expect(closeout.checklist).toContainEqual(expect.objectContaining({ id: 'schedule_coverage', count: 1, status: 'blocked' }));
    expect(closeout.can_complete).toBe(false);
    expect(await t.run(ctx => ctx.db.query('attendance').collect())).toEqual(rawBefore);
    expect(await t.run(ctx => ctx.db.query('attendanceCorrections').collect())).toEqual([]);
  });
  it('keeps the department assignment unique despite duplicate defaults and preserves daily attendance after clock-out', async () => {
    const { t, actor, workerId } = await setup('unique');
    await t.run(ctx => ctx.db.insert('attendance', { workerId: String(workerId), timestamp: `${date}T08:30:00`, eventType: 'clock_in', synced: true }));
    const briefing = await actor.query(api.shiftBriefing.summary, { date });
    expect(briefing.coverage_unavailable).toBe(0);
    expect(briefing.schedule_assignment_warnings).toEqual([]);
    expect(briefing.summary).toMatchObject({ expected: 1, present: 0, clocked_out: 1 });
    expect(briefing.daily_attendance).toEqual({ expected: 1, present: 1, late: 1, missing: 0 });
    expect(briefing.workers[0].schedule_name).toBe('Assembly one');
  });
  it('changes coverage source identity when a reviewed ambiguous candidate is replaced at the same time/count', async () => {
    const { t, actor } = await setup('ambiguous');
    const before = await actor.query(api.shiftBriefing.summary, { date });
    const beforeCloseout = await actor.query(api.shiftCloseouts.get, { date });
    await t.run(async ctx => {
      const candidate = (await ctx.db.query('schedules').collect()).find(row => row.name === 'Assembly one')!;
      const { _id, _creationTime, ...fields } = candidate;
      await ctx.db.delete(_id); await ctx.db.insert('schedules', fields);
    });
    const after = await actor.query(api.shiftBriefing.summary, { date });
    expect(after.coverage_unavailable).toBe(before.coverage_unavailable);
    expect(after.coverage_evidence).not.toEqual(before.coverage_evidence);
    const afterCloseout = await actor.query(api.shiftCloseouts.get, { date });
    // When composed with rank 6, its acknowledgement must cover these identities.
    if ('blocker_evidence' in beforeCloseout && 'blocker_evidence' in afterCloseout) {
      expect(afterCloseout.blocker_evidence).not.toEqual(beforeCloseout.blocker_evidence);
    }
  });
});
