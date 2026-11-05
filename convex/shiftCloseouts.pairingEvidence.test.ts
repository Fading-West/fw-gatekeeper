/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.ts');
const date = '2026-09-03';
const nextDate = '2026-09-04';
afterEach(() => vi.useRealTimers());

async function fixture() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-02T12:00:00Z'));
  const t = convexTest(schema, modules);
  const { userId, workerId } = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'pairing-supervisor@example.test' });
    await ctx.db.insert('portalMembers', { userId, role: 'enrollment', active: true, createdAt: date });
    const workerId = await ctx.db.insert('workers', { name: 'Overnight worker', department: 'Assembly', active: true, enrolledAt: date });
    await ctx.db.insert('schedules', { name: 'Day', department: 'Assembly', days: '[0,1,2,3,4,5,6]', startTime: '07:00', endTime: '15:00', active: true, createdAt: date });
    await ctx.db.insert('attendance', { workerId, eventType: 'clock_in', timestamp: `${date}T14:00:00`, synced: true });
    return { userId, workerId };
  });
  // Retrospective review: no clock tick or in-progress transition in this test.
  vi.setSystemTime(new Date('2026-09-05T18:00:00Z'));
  const actor = t.withIdentity({ subject: userId });
  const load = () => actor.query(api.shiftCloseouts.get, { date });
  const source = async () => (await actor.query(api.shiftExceptions.summary, { date })).exceptions.find(row => row.type === 'missing_clock_out')!;
  const addNextShift = (start = '01:00', end = '02:00') => t.run(async ctx => {
    await ctx.db.insert('attendance', { workerId, eventType: 'clock_in', timestamp: `${nextDate}T${start}:00`, synced: true });
    await ctx.db.insert('attendance', { workerId, eventType: 'clock_out', timestamp: `${nextDate}T${end}:00`, synced: true });
  });
  const original = await load();
  const acknowledge = () => actor.mutation(api.shiftCloseouts.save, {
    date, requestId: 'acknowledge', expectedRevision: null, action: 'save',
    acknowledgedBlockers: true, blockerEvidence: original.blocker_evidence, notes: 'Missing exit reviewed against available scans.',
  });
  return { t, actor, load, source, addNextShift, original, acknowledge };
}

it('requires renewed closeout acknowledgement when overnight pairing evidence changes', async () => {
  const f = await fixture();
  const before = await f.source();
  expect(before.suggested_resolution.can_apply).toBe(true);
  const saved = await f.acknowledge();
  const persisted = await f.t.run(ctx => ctx.db.get(saved.id));
  await f.addNextShift();
  const after = await f.source();
  // The same blocker/count now has a plausible exit competing with the next entry.
  expect(after.source_evidence).toBe(before.source_evidence);
  expect(after.suggested_resolution).toMatchObject({ action: 'review_only', can_apply: false });
  const changed = await f.load();
  expect(changed.summary).toEqual(f.original.summary);
  await expect(f.actor.mutation(api.shiftCloseouts.save, {
    date, requestId: 'stale-complete', expectedRevision: saved.revision, action: 'complete',
  })).rejects.toMatchObject({ data: { code: 'CLOSEOUT_BLOCKERS_CHANGED' } });
  expect(await f.t.run(ctx => ctx.db.get(saved.id))).toEqual(persisted);
  expect(await f.t.run(ctx => ctx.db.query('shiftCloseoutHistory').collect())).toEqual([]);
  expect(changed.closeout).toMatchObject({ acknowledged_blockers: false, acknowledgement_stale: true });
  expect(changed.can_complete).toBe(false);
  expect((await f.actor.mutation(api.shiftCloseouts.save, {
    date, requestId: 'renewed-complete', expectedRevision: saved.revision, action: 'complete',
    acknowledgedBlockers: true, blockerEvidence: changed.blocker_evidence, notes: 'Competing overnight scans reviewed.',
  })).status).toBe('completed');
});

it('rejects a stale submitted acknowledgement before creating any closeout', async () => {
  const f = await fixture();
  await f.addNextShift();
  await expect(f.actor.mutation(api.shiftCloseouts.save, {
    date, requestId: 'stale-submitted', expectedRevision: null, action: 'complete',
    acknowledgedBlockers: true, blockerEvidence: f.original.blocker_evidence, notes: 'Old evidence reviewed.',
  })).rejects.toMatchObject({ data: { code: 'CLOSEOUT_BLOCKERS_CHANGED' } });
  expect(await f.t.run(ctx => ctx.db.query('shiftCloseouts').collect())).toEqual([]);
  expect(await f.t.run(ctx => ctx.db.query('shiftCloseoutActionReceipts').collect())).toEqual([]);
});

it('keeps acknowledgement for unrelated next-day punches beyond the 16-hour horizon', async () => {
  const f = await fixture();
  const saved = await f.acknowledge();
  await f.addNextShift('07:00', '15:00');
  const unchanged = await f.load();
  expect(unchanged.blocker_evidence).toBe(f.original.blocker_evidence);
  expect(unchanged.closeout).toMatchObject({ acknowledged_blockers: true, acknowledgement_stale: false });
  expect((await f.actor.mutation(api.shiftCloseouts.save, {
    date, requestId: 'unchanged-complete', expectedRevision: saved.revision, action: 'complete',
  })).status).toBe('completed');
});
