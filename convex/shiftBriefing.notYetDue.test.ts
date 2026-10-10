/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.ts');
// Thursday in Central Daylight Time (UTC-5).
const DATE = '2026-09-03';

type Shift = { name: string; department: string; startTime: string; endTime: string; worker: string };
const DAY_SHIFT: Shift = { name: 'Day', department: 'Assembly', startTime: '08:00', endTime: '17:00', worker: 'Avery' };
const SECOND_SHIFT: Shift = { name: 'Second', department: 'Paint', startTime: '14:00', endTime: '22:00', worker: 'Blake' };

async function fixture(shifts: Shift[] = [DAY_SHIFT]) {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const createdAt = '2026-08-01T00:00:00Z';
    const userId = await ctx.db.insert('users', { email: 'supervisor@example.com' });
    await ctx.db.insert('portalMembers', { userId, role: 'admin', active: true, createdAt });
    const workers: Record<string, string> = {};
    for (const shift of shifts) {
      workers[shift.worker] = String(await ctx.db.insert('workers', {
        name: shift.worker,
        department: shift.department,
        active: true,
        enrolledAt: createdAt,
        faceEncoding: Array(512).fill(0.1),
      }));
      await ctx.db.insert('schedules', {
        name: shift.name,
        department: shift.department,
        days: '[0,1,2,3,4,5,6]',
        startTime: shift.startTime,
        endTime: shift.endTime,
        active: true,
        createdAt,
      });
    }
    return { userId, workers };
  });
  return { t, admin: t.withIdentity({ subject: ids.userId }), workers: ids.workers };
}

function at(isoUtc: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(isoUtc));
}

async function load(admin: any, date = DATE) {
  const [briefing, exceptions] = await Promise.all([
    admin.query(api.shiftBriefing.summary, { date }),
    admin.query(api.shiftExceptions.summary, { date }),
  ]);
  // The briefing and the exception queue must always agree on who is missing.
  const briefingMissing = briefing.workers.filter((row: any) => row.status === 'missing').map((row: any) => row.worker_id).sort();
  const exceptionMissing = exceptions.exceptions.filter((row: any) => row.type === 'missing_arrival').map((row: any) => row.worker_id).sort();
  expect(briefingMissing).toEqual(exceptionMissing);
  return briefing;
}

function statusOf(briefing: any, name: string) {
  return briefing.workers.find((row: any) => row.worker_name === name)?.status;
}

describe('shift briefing does not mark workers missing before their shift starts', () => {
  afterEach(() => vi.useRealTimers());

  it('shows an unscanned worker as not yet due at 07:00 for an 08:00 start, without blocking readiness', async () => {
    at('2026-09-03T12:00:00Z'); // 07:00 Central
    const { admin } = await fixture();
    const briefing = await load(admin);

    expect(statusOf(briefing, 'Avery')).toBe('not_yet_due');
    expect(briefing.summary).toMatchObject({ expected: 1, present: 0, late: 0, missing: 0, not_yet_due: 1, critical_actions: 0 });
    expect(briefing.daily_attendance).toMatchObject({ expected: 1, present: 0, late: 0, missing: 0, not_yet_due: 1 });
    expect(briefing.departments).toEqual([expect.objectContaining({ department: 'Assembly', missing: 0, not_yet_due: 1, status: 'not_yet_due' })]);
    expect(briefing.action_items.some((item: any) => item.id.startsWith('coverage:'))).toBe(false);

    const brief = briefing.shift_trust_brief;
    expect(brief.readiness_status).toBe('ready');
    expect(brief.readiness_blockers.map((risk: any) => risk.id)).not.toContain('attendance:missing-arrivals');
    expect(brief.source_counts).toMatchObject({ expected: 1, missing: 0, not_yet_due: 1 });
    expect(brief.summary_sentence).toContain('0/1 expected workers are present, 0 late, 0 missing, 1 not yet due');
  });

  it('keeps the strict scheduled-start boundary shared with shift exceptions', async () => {
    at('2026-09-03T13:00:00Z'); // exactly 08:00:00 Central
    const { admin } = await fixture();
    expect(statusOf(await load(admin), 'Avery')).toBe('not_yet_due');

    vi.setSystemTime(new Date('2026-09-03T13:00:01Z')); // 08:00:01 Central
    expect(statusOf(await load(admin), 'Avery')).toBe('missing');
  });

  it('marks the worker missing and blocks readiness once the start has passed without a scan', async () => {
    at('2026-09-03T13:05:00Z'); // 08:05 Central
    const { admin } = await fixture();
    const briefing = await load(admin);

    expect(statusOf(briefing, 'Avery')).toBe('missing');
    expect(briefing.summary).toMatchObject({ expected: 1, missing: 1, not_yet_due: 0 });
    expect(briefing.daily_attendance).toMatchObject({ missing: 1, not_yet_due: 0 });
    expect(briefing.departments[0]).toMatchObject({ status: 'critical', missing: 1, not_yet_due: 0 });
    expect(briefing.shift_trust_brief.readiness_status).toBe('blocked');
    expect(briefing.shift_trust_brief.readiness_blockers).toContainEqual(expect.objectContaining({ id: 'attendance:missing-arrivals', count: 1 }));
    expect(briefing.shift_trust_brief.summary_sentence).not.toContain('not yet due');
  });

  it('keeps second-shift workers out of missing and critical coverage until their own start', async () => {
    at('2026-09-03T15:00:00Z'); // 10:00 Central
    const { t, admin, workers } = await fixture([DAY_SHIFT, SECOND_SHIFT]);
    await t.run((ctx) => ctx.db.insert('attendance', { workerId: workers.Avery, eventType: 'clock_in', timestamp: `${DATE}T07:55:00`, synced: true }));

    const morning = await load(admin);
    expect(statusOf(morning, 'Avery')).toBe('present');
    expect(statusOf(morning, 'Blake')).toBe('not_yet_due');
    expect(morning.summary).toMatchObject({ expected: 2, present: 1, missing: 0, not_yet_due: 1, critical_actions: 0 });
    expect(morning.departments.find((row: any) => row.department === 'Paint')).toMatchObject({ status: 'not_yet_due', not_yet_due: 1 });
    expect(morning.departments.find((row: any) => row.department === 'Assembly')).toMatchObject({ status: 'covered' });
    expect(morning.shift_trust_brief.readiness_status).toBe('ready');

    vi.setSystemTime(new Date('2026-09-03T19:30:00Z')); // 14:30 Central
    const afternoon = await load(admin);
    expect(statusOf(afternoon, 'Blake')).toBe('missing');
    expect(afternoon.summary).toMatchObject({ missing: 1, not_yet_due: 0 });
    expect(afternoon.departments.find((row: any) => row.department === 'Paint')).toMatchObject({ status: 'critical', missing: 1 });
    expect(afternoon.shift_trust_brief.readiness_status).toBe('blocked');
  });

  it('shows every scheduled worker as not yet due on a future date', async () => {
    at('2026-09-03T20:00:00Z'); // 15:00 Central, the day before
    const { admin } = await fixture([DAY_SHIFT, SECOND_SHIFT]);
    const briefing = await load(admin, '2026-09-04');

    expect(briefing.workers.map((row: any) => row.status)).toEqual(['not_yet_due', 'not_yet_due']);
    expect(briefing.summary).toMatchObject({ expected: 2, missing: 0, not_yet_due: 2, critical_actions: 0 });
    expect(briefing.shift_trust_brief.readiness_status).toBe('ready');
  });

  it('leaves past dates and closeout unchanged', async () => {
    at('2026-09-04T15:00:00Z'); // the next morning
    const { admin } = await fixture([DAY_SHIFT, SECOND_SHIFT]);
    const briefing = await load(admin);

    expect(briefing.workers.map((row: any) => row.status)).toEqual(['missing', 'missing']);
    expect(briefing.summary).toMatchObject({ expected: 2, missing: 2, not_yet_due: 0 });
    expect(briefing.shift_trust_brief.readiness_status).toBe('blocked');
    const closeout = await admin.query(api.shiftCloseouts.get, { date: DATE });
    expect(closeout.summary).toMatchObject({ expected: 2, present: 0, late: 0, missing: 2 });
  });

  it('keeps closeout opened before a shift starts arithmetically consistent', async () => {
    at('2026-09-03T15:00:00Z'); // 10:00 Central: day shift running, second shift due at 14:00
    const { t, admin, workers } = await fixture([DAY_SHIFT, SECOND_SHIFT]);
    await t.run((ctx) => ctx.db.insert('attendance', { workerId: workers.Avery, eventType: 'clock_in', timestamp: `${DATE}T07:55:00`, synced: true }));

    const closeout = await admin.query(api.shiftCloseouts.get, { date: DATE });
    expect(closeout.summary).toMatchObject({ expected: 2, present: 1, late: 0, missing: 0, not_yet_due: 1 });
    expect(closeout.suggested_note).toContain('2 expected, 1 present, 0 late, 0 missing, 1 not yet due,');
    const attendance = closeout.closeout_draft.sections.find((section: any) => section.id === 'attendance_summary');
    expect(attendance?.paragraph).toContain('1 scheduled worker is not yet due because their shift has not started.');

    vi.setSystemTime(new Date('2026-09-04T15:00:00Z')); // next morning: nobody is not yet due
    const after = await admin.query(api.shiftCloseouts.get, { date: DATE });
    expect(after.summary).toMatchObject({ expected: 2, present: 1, missing: 1, not_yet_due: 0 });
    expect(after.suggested_note).not.toContain('not yet due');
    expect(after.closeout_draft.narrative).not.toContain('not yet due');
  });

  it('requires an acknowledgement note to sign a closeout before a shift starts', async () => {
    at('2026-09-03T15:00:00Z'); // second shift not due until 14:00 Central
    const { t, admin, workers } = await fixture([DAY_SHIFT, SECOND_SHIFT]);
    await t.run((ctx) => ctx.db.insert('attendance', { workerId: workers.Avery, eventType: 'clock_in', timestamp: `${DATE}T07:55:00`, synced: true }));

    const closeout = await admin.query(api.shiftCloseouts.get, { date: DATE });
    expect(closeout.can_complete).toBe(false);
    expect(closeout.blockers).toContainEqual(expect.objectContaining({ id: 'not_yet_due', count: 1 }));
    await expect(admin.mutation(api.shiftCloseouts.save, { date: DATE, action: 'complete' })).rejects.toThrow('acknowledgement note');
    await admin.mutation(api.shiftCloseouts.save, { date: DATE, action: 'complete', notes: 'Signed early; Blake not yet due', acknowledgedBlockers: true });
    const signed = await admin.query(api.shiftCloseouts.get, { date: DATE });
    expect(signed.closeout).toMatchObject({ status: 'completed', notes: 'Signed early; Blake not yet due' });
    expect(signed.closeout?.snapshot).toMatchObject({ expected: 2, present: 1, missing: 0 });

    vi.setSystemTime(new Date('2026-09-04T15:00:00Z')); // past date: no not-yet-due checklist item
    expect((await admin.query(api.shiftCloseouts.get, { date: DATE })).checklist.map((item: any) => item.id)).not.toContain('not_yet_due');
  });

  it('uses the factory timezone across the DST fall-back change', async () => {
    // 2026-11-01 is the CDT -> CST switch; 13:30Z is 07:30 CST (08:30 under CDT).
    at('2026-11-01T13:30:00Z');
    const { admin } = await fixture();
    expect(statusOf(await load(admin, '2026-11-01'), 'Avery')).toBe('not_yet_due');

    vi.setSystemTime(new Date('2026-11-01T14:01:00Z')); // 08:01 CST
    expect(statusOf(await load(admin, '2026-11-01'), 'Avery')).toBe('missing');
  });
});
