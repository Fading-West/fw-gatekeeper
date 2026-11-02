/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.ts');
const date = '2026-09-03';
const notes = 'Pending shift roster reviewed; gate is offline.';
afterEach(() => vi.useRealTimers());

async function fixture(workerCount = 1) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${date}T12:00:00Z`)); // 07:00 Central, before the shift.
  const t = convexTest(schema, modules);
  const ids = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'synthetic-supervisor@example.test' });
    await ctx.db.insert('portalMembers', { userId, role: 'enrollment', active: true, createdAt: date });
    const scheduleId = await ctx.db.insert('schedules', {
      name: 'Day', department: 'Assembly', days: '[0,1,2,3,4,5,6]',
      startTime: '08:00', endTime: '17:00', active: true, createdAt: date,
    });
    const workerId = await ctx.db.insert('workers', {
      name: 'First', department: 'Assembly', active: true, enrolledAt: date,
      faceEncoding: Array(512).fill(0.1),
    });
    if (workerCount === 2) await ctx.db.insert('workers', {
      name: 'Second', department: 'Assembly', active: true, enrolledAt: date,
      faceEncoding: Array(512).fill(0.1),
    });
    const kioskId = await ctx.db.insert('kiosks', { name: 'Gate', type: 'entry', location: 'Factory', active: true });
    return { userId, scheduleId, workerId, kioskId };
  });
  const actor = t.withIdentity({ subject: ids.userId });
  const load = () => actor.query(api.shiftCloseouts.get, { date });
  const original = await load();
  expect(original.summary.not_yet_due).toBe(workerCount);
  const acknowledge = () => actor.mutation(api.shiftCloseouts.save, {
    date, requestId: 'acknowledge', expectedRevision: null, action: 'save',
    acknowledgedBlockers: true, blockerEvidence: original.blocker_evidence, notes,
  });
  return { t, actor, load, original, acknowledge, ...ids };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const changes = {
  'worker added': async ({ t }: Fixture) => {
    await t.run(ctx => ctx.db.insert('workers', { name: 'Second', department: 'Assembly', active: true, enrolledAt: date, faceEncoding: Array(512).fill(0.1) }));
  },
  'worker replaced at the same count': async ({ t, workerId }: Fixture) => {
    await t.run(async ctx => {
      await ctx.db.patch(workerId, { active: false });
      await ctx.db.insert('workers', { name: 'Replacement', department: 'Assembly', active: true, enrolledAt: date, faceEncoding: Array(512).fill(0.1) });
    });
  },
  'scheduled start changed': async ({ t, scheduleId }: Fixture) => {
    await t.run(ctx => ctx.db.patch(scheduleId, { startTime: '09:00' }));
  },
  'scheduled end changed': async ({ t, scheduleId }: Fixture) => {
    await t.run(ctx => ctx.db.patch(scheduleId, { endTime: '18:00' }));
  },
};

describe('future shift acknowledgement evidence', () => {
  it.each(Object.entries(changes))('invalidates a saved acknowledgement after %s', async (_label, change) => {
    const f = await fixture();
    const saved = await f.acknowledge();
    await change(f);
    const changed = await f.load();
    expect(changed.blocker_evidence).not.toBe(f.original.blocker_evidence);
    expect(changed.closeout).toMatchObject({ acknowledged_blockers: false, acknowledgement_stale: true, notes });
    expect(changed.can_complete).toBe(false);
    await expect(f.actor.mutation(api.shiftCloseouts.save, {
      date, requestId: 'complete', expectedRevision: saved.revision, action: 'complete',
    })).rejects.toMatchObject({ data: { code: 'CLOSEOUT_BLOCKERS_CHANGED' } });
    expect(await f.t.run(ctx => ctx.db.query('shiftCloseoutHistory').collect())).toEqual([]);
    const renewed = await f.actor.mutation(api.shiftCloseouts.save, {
      date, requestId: 'renewed', expectedRevision: saved.revision, action: 'complete',
      acknowledgedBlockers: true, blockerEvidence: changed.blocker_evidence, notes: 'Current workers and schedule reviewed.',
    });
    expect(renewed.status).toBe('completed');
  });

  it.each(Object.entries(changes))('rejects a stale submitted acknowledgement after %s', async (_label, change) => {
    const f = await fixture();
    await change(f);
    await expect(f.actor.mutation(api.shiftCloseouts.save, {
      date, requestId: 'stale-draft', expectedRevision: null, action: 'complete',
      acknowledgedBlockers: true, blockerEvidence: f.original.blocker_evidence, notes,
    })).rejects.toMatchObject({ data: { code: 'CLOSEOUT_BLOCKERS_CHANGED' } });
    expect(await f.t.run(ctx => ctx.db.query('shiftCloseouts').collect())).toEqual([]);
  });

  it('keeps acknowledgement through clock ticks, names and unchanged schedule writes', async () => {
    const f = await fixture(2);
    const saved = await f.acknowledge();
    vi.setSystemTime(new Date(`${date}T12:30:00Z`));
    await f.t.run(async ctx => {
      await ctx.db.patch(f.workerId, { name: 'Z Renamed worker' });
      await ctx.db.patch(f.scheduleId, { name: 'Renamed shift', startTime: '08:00', endTime: '17:00' });
      await ctx.db.patch(f.kioskId, { name: 'Renamed gate' });
    });
    const unchanged = await f.load();
    expect(unchanged.blocker_evidence).toBe(f.original.blocker_evidence);
    expect(unchanged.closeout).toMatchObject({ acknowledged_blockers: true, acknowledgement_stale: false });
    expect((await f.actor.mutation(api.shiftCloseouts.save, {
      date, requestId: 'unchanged', expectedRevision: saved.revision, action: 'complete',
    })).status).toBe('completed');
  });

  it('invalidates when the last future worker starts while another blocker persists', async () => {
    const f = await fixture();
    const saved = await f.acknowledge();
    vi.setSystemTime(new Date(`${date}T13:01:00Z`));
    await f.t.run(ctx => ctx.db.insert('attendance', {
      workerId: f.workerId, eventType: 'clock_in', timestamp: `${date}T08:00:00`, synced: true,
    }));
    const changed = await f.load();
    expect(changed.summary).toMatchObject({ not_yet_due: 0, kiosk_warnings: 1, open_exceptions: 0 });
    expect(changed.blocker_evidence).not.toBe(f.original.blocker_evidence);
    expect(changed.closeout?.acknowledgement_stale).toBe(true);
    await expect(f.actor.mutation(api.shiftCloseouts.save, {
      date, requestId: 'started', expectedRevision: saved.revision, action: 'complete',
    })).rejects.toMatchObject({ data: { code: 'CLOSEOUT_BLOCKERS_CHANGED' } });
  });

  it('preserves the prior evidence shape and saved acknowledgement when no worker is future', async () => {
    const f = await fixture();
    vi.setSystemTime(new Date(`${date}T13:01:00Z`));
    await f.t.run(ctx => ctx.db.insert('attendance', {
      workerId: f.workerId, eventType: 'clock_in', timestamp: `${date}T08:00:00`, synced: true,
    }));
    const current = await f.load();
    const parsed = JSON.parse(current.blocker_evidence);
    expect(Object.keys(parsed)).toEqual(['version', 'date', 'coverage', 'exceptions', 'kiosks']);
    const saved = await f.actor.mutation(api.shiftCloseouts.save, {
      date, requestId: 'old-shape', expectedRevision: null, action: 'save',
      acknowledgedBlockers: true, blockerEvidence: current.blocker_evidence, notes: 'Offline gate reviewed.',
    });
    vi.setSystemTime(new Date(`${date}T13:30:00Z`));
    expect((await f.load()).closeout?.acknowledgement_stale).toBe(false);
    expect((await f.actor.mutation(api.shiftCloseouts.save, {
      date, requestId: 'legacy-complete', expectedRevision: saved.revision, action: 'complete',
    })).status).toBe('completed');
  });
});
