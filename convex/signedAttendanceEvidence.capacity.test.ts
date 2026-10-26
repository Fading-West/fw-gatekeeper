/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { expect, it } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';
import { MAX_ATTENDANCE_EVIDENCE_ROWS } from './signedAttendanceEvidence';

// Convex enforces per-transaction document and index-range limits. These run the
// closeout with those limits enabled: baseline capture must not push a day that
// loads successfully over them.
const modules = import.meta.glob('./**/*.ts');
const date = '2026-09-02';

async function setup() {
  const t = convexTest({ schema, modules, transactionLimits: true });
  const ids = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'capacity@example.invalid' });
    await ctx.db.insert('portalMembers', { userId, role: 'enrollment', active: true, createdAt: date });
    const workerId = await ctx.db.insert('workers', { name: 'Synthetic', department: 'QA', active: false, enrolledAt: date });
    return { userId, workerId };
  });
  const actor = t.withIdentity({ subject: ids.userId });
  const complete = async () => {
    const payload = await actor.query(api.shiftCloseouts.get, { date });
    return actor.mutation(api.shiftCloseouts.save, { date, action: 'complete', notes: 'Synthetic capacity review', acknowledgedBlockers: true, blockerEvidence: payload.blocker_evidence });
  };
  return { t, actor, complete, ...ids };
}

it('signs and compares 1,000 scheduled workers with neighboring days inside transaction limits', async () => {
  const { t, actor, complete } = await setup();
  await t.run(ctx => ctx.db.insert('schedules', { name: 'Day', days: '[0,1,2,3,4,5,6]',
    startTime: '08:00', endTime: '17:00', department: 'QA', active: true, createdAt: date }));
  for (let start = 0; start < 1000; start += 100) {
    await t.run(async ctx => {
      for (let i = start; i < start + 100; i++) {
        const workerId = await ctx.db.insert('workers', { name: `Worker ${i}`, department: 'QA', active: true, enrolledAt: date });
        for (const day of ['2026-08-31', '2026-09-01', date, '2026-09-03', '2026-09-04']) {
          await ctx.db.insert('attendance', { workerId, eventType: 'clock_in', synced: true, timestamp: `${day}T08:00:00` });
          await ctx.db.insert('attendance', { workerId, eventType: 'clock_out', synced: true, timestamp: `${day}T17:00:00` });
        }
      }
    });
  }
  const { id } = await complete();
  expect((await t.run(ctx => ctx.db.get(id)))?.signedAttendanceEvidence).toMatchObject({ raw_punches: 2000 });
  expect((await actor.query(api.shiftCloseouts.get, { date })).attendance_comparison.status).toBe('unchanged');
}, 120_000);

it('signs a correction-heavy day without exhausting index ranges', async () => {
  const { t, actor, complete, workerId, userId } = await setup();
  await t.run(async ctx => {
    for (let i = 0; i < 1100; i++) {
      await ctx.db.insert('attendanceCorrections', { date, workerId, action: 'add_clock_out', eventType: 'clock_out',
        correctedTimestamp: `${date}T17:00:00`, reason: 'Synthetic', actorUserId: userId, createdAt: date, updatedAt: date });
    }
  });
  const { id } = await complete();
  expect((await t.run(ctx => ctx.db.get(id)))?.signedAttendanceEvidence).toMatchObject({ corrections: 1100 });
  expect((await actor.query(api.shiftCloseouts.get, { date })).attendance_comparison.status).toBe('unchanged');
}, 120_000);

it('does not let busy adjacent dates in the conservative scan block a new signature', async () => {
  const { t, actor, complete, workerId } = await setup();
  // Neighboring factory dates share the scanned timestamp prefixes but are not evidence for this date.
  for (let start = 0; start <= MAX_ATTENDANCE_EVIDENCE_ROWS; start += 1000) {
    await t.run(async ctx => {
      for (let i = start; i < Math.min(start + 1000, MAX_ATTENDANCE_EVIDENCE_ROWS + 1); i++) {
        await ctx.db.insert('attendance', { workerId, eventType: 'clock_in', synced: true,
          timestamp: `2026-09-0${i % 2 ? 1 : 3}T12:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.${i}Z` });
      }
    });
  }
  await t.run(ctx => ctx.db.insert('attendance', { workerId, eventType: 'clock_in', synced: true, timestamp: `${date}T08:00:00` }));
  const { id } = await complete();
  expect((await t.run(ctx => ctx.db.get(id)))?.signedAttendanceEvidence).toMatchObject({ raw_punches: 1 });
  expect((await actor.query(api.shiftCloseouts.get, { date })).attendance_comparison.status).toBe('unchanged');
}, 120_000);
