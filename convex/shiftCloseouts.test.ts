/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import type { FunctionArgs } from 'convex/server';
import { describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.ts');
const date = '2026-09-10';
async function setup(completed = false) {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert('users', { email: 'supervisor@example.com' });
    await ctx.db.insert('portalMembers', { userId, role: 'enrollment', active: true, createdAt: '2026-09-10T00:00:00Z' });
    const closeoutId = completed ? await ctx.db.insert('shiftCloseouts', {
      date, status: 'completed', notes: 'Original signed notes', supervisorName: 'Signed supervisor',
      acknowledgedBlockers: true, expected: 9, present: 8, late: 1, missing: 0,
      openExceptions: 0, criticalExceptions: 0, kioskWarnings: 0,
      completedAt: '2026-09-10T22:00:00Z', createdAt: '2026-09-10T20:00:00Z', updatedAt: '2026-09-10T22:00:00Z',
    }) : null;
    return { userId, closeoutId };
  });
  return { t, actor: t.withIdentity({ subject: ids.userId }), ...ids };
}

describe('closeout signed record integrity', () => {
  it('rejects edits to completed notes and makes duplicate complete requests harmless', async () => {
    const { t, actor, closeoutId } = await setup(true);
    const before = await t.run((ctx) => ctx.db.get(closeoutId!));
    await expect(save(actor, { date, action: 'save', notes: 'Overwrite' })).rejects.toThrow('Reopen');
    await save(actor, { date, action: 'complete', notes: 'Overwrite on retry', supervisorName: 'Different person' });
    expect(await t.run((ctx) => ctx.db.get(closeoutId!))).toEqual(before);
    expect(await t.run((ctx) => ctx.db.query('shiftCloseoutHistory').collect())).toEqual([]);
  });

  it('archives the prior signed record on reopen and requires fresh blocker acknowledgement', async () => {
    const { t, actor, closeoutId, userId } = await setup(true);
    await t.run((ctx) => ctx.db.insert('kiosks', { name: 'Offline gate', kioskId: 'gate-1', type: 'entry', location: 'Entry', active: true }));
    await save(actor, { date, action: 'reopen', notes: 'Must not overwrite', acknowledgedBlockers: true });
    const reopened = await t.run((ctx) => ctx.db.get(closeoutId!));
    expect(reopened).toMatchObject({ status: 'reopened', notes: 'Original signed notes', expected: 9, acknowledgedBlockers: false });
    const history = await t.run((ctx) => ctx.db.query('shiftCloseoutHistory').collect());
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ actorUserId: userId, action: 'reopen', before: { status: 'completed', notes: 'Original signed notes', expected: 9 }, after: { status: 'reopened', acknowledgedBlockers: false } });
    await expect(save(actor, { date, action: 'complete' })).rejects.toThrow('acknowledgement note');
    const evidence = (await actor.query(api.shiftCloseouts.get, { date })).blocker_evidence;
    await save(actor, { date, action: 'complete', notes: 'Offline gate evidence reviewed', acknowledgedBlockers: true, blockerEvidence: evidence });
    const completed = await t.run((ctx) => ctx.db.get(closeoutId!));
    expect(completed).toMatchObject({ status: 'completed', notes: 'Offline gate evidence reviewed', kioskWarnings: 1 });
    expect((await t.run((ctx) => ctx.db.query('shiftCloseoutHistory').collect()))).toHaveLength(2);
  });

  it('records the authenticated actor once for a new completion and rejects invalid reopen/date requests', async () => {
    const { t, actor, userId } = await setup();
    await expect(save(actor, { date, action: 'reopen' })).rejects.toThrow('Only a completed');
    await expect(save(actor, { date: '2026-02-30', action: 'save' })).rejects.toThrow('YYYY-MM-DD');
    const completed = await save(actor, { date, action: 'complete', notes: 'Clear' });
    await save(actor, { date, action: 'complete' });
    const history = await t.run((ctx) => ctx.db.query('shiftCloseoutHistory').collect());
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ closeoutId: completed.id, actorUserId: userId, action: 'complete', after: { notes: 'Clear', status: 'completed' } });
    await expect(save(t, { date, action: 'reopen' })).rejects.toThrow('Unauthorized');
  });
});

let fixtureRequest = 0;
async function save(actor: Awaited<ReturnType<typeof setup>>['actor'], args: Omit<FunctionArgs<typeof api.shiftCloseouts.save>, 'requestId' | 'expectedRevision'>) {
  const current = await actor.query(api.shiftCloseouts.get, { date: args.date });
  return actor.mutation(api.shiftCloseouts.save, { ...args, requestId: `synthetic-fixture-${++fixtureRequest}`,
    expectedRevision: current.closeout ? current.closeout.revision ?? 0 : null });
}
