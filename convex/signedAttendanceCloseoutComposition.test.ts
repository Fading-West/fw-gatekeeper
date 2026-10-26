/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { expect, it } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';

const modules = import.meta.glob('./**/*.ts');
const date = '2026-09-02';

it('preserves the original receipt, signed attendance and signed queue after reopen, then captures both again on deliberate re-sign', async () => {
  const t = convexTest({ schema, modules, transactionLimits: true });
  const { userId, kioskId } = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'composition@example.invalid' });
    await ctx.db.insert('portalMembers', { userId, role: 'enrollment', active: true, createdAt: date });
    const now = new Date().toISOString();
    const kioskId = await ctx.db.insert('kiosks', { name: 'Synthetic gate', type: 'entry', location: 'QA', active: true, lastSync: now,
      attendanceQueue: { lastValidCount: 3, observedAt: now, latest: 'reported' },
      health: { cameraOk: true, modelOk: true, livenessAvailable: true, reportedAt: now } });
    await ctx.db.insert('attendance', { workerId: 'synthetic-local-worker', eventType: 'clock_in', timestamp: `${date}T08:00:00`, synced: true });
    return { userId, kioskId };
  });
  const actor = t.withIdentity({ subject: userId });
  const initial = await actor.query(api.shiftCloseouts.get, { date });
  const request = { date, action: 'complete' as const, requestId: 'original-complete', expectedRevision: null,
    notes: 'Reviewed the queue', acknowledgedBlockers: true, blockerEvidence: initial.blocker_evidence };
  const signed = await actor.mutation(api.shiftCloseouts.save, request);
  const original = await t.run(ctx => ctx.db.get(signed.id));
  expect(original?.signedAttendanceEvidence).toMatchObject({ raw_punches: 1 });
  expect(original?.attendanceQueueEvidence).toMatchObject({ pendingRecords: 3 });

  await t.run(async ctx => {
    await ctx.db.insert('attendance', { workerId: 'synthetic-local-worker', eventType: 'clock_out', timestamp: `${date}T17:00:00`, synced: true });
    await ctx.db.patch(kioskId, { attendanceQueue: { lastValidCount: 0, observedAt: new Date().toISOString(), latest: 'reported' } });
  });
  expect((await actor.query(api.shiftCloseouts.get, { date })).attendance_comparison.status).toBe('changed');
  const reopened = await actor.mutation(api.shiftCloseouts.save, { date, action: 'reopen', requestId: 'deliberate-reopen', expectedRevision: signed.revision });
  expect(await actor.mutation(api.shiftCloseouts.save, request)).toEqual(signed);
  const afterReplay = await t.run(ctx => ctx.db.get(signed.id));
  expect(afterReplay).toMatchObject({ status: 'reopened', revision: reopened.revision });
  expect(afterReplay?.signedAttendanceEvidence).toEqual(original?.signedAttendanceEvidence);
  expect(afterReplay?.attendanceQueueEvidence).toEqual(original?.attendanceQueueEvidence);
  expect(await t.run(ctx => ctx.db.query('shiftCloseoutHistory').collect())).toHaveLength(2);

  const current = await actor.query(api.shiftCloseouts.get, { date });
  await actor.mutation(api.shiftCloseouts.save, { date, action: 'complete', requestId: 'deliberate-resign', expectedRevision: reopened.revision,
    notes: 'Reviewed updated evidence', acknowledgedBlockers: true, blockerEvidence: current.blocker_evidence });
  const resigned = await t.run(ctx => ctx.db.get(signed.id));
  expect(resigned?.signedAttendanceEvidence).toMatchObject({ raw_punches: 2 });
  expect(resigned?.signedAttendanceEvidence).not.toEqual(original?.signedAttendanceEvidence);
  expect(resigned?.attendanceQueueEvidence).toMatchObject({ pendingRecords: 0 });
  expect((await actor.query(api.shiftCloseouts.get, { date })).attendance_comparison.status).toBe('unchanged');
  expect(await t.run(ctx => ctx.db.query('shiftCloseoutHistory').collect())).toHaveLength(3);
});
