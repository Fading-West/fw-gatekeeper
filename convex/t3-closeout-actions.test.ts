/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';
const modules = import.meta.glob('./**/*.ts');
const date = '2026-09-03';
async function setup() {
  const t = convexTest(schema, modules);
  const userIds = await t.run(async ctx => {
    const ids = [];
    for (const name of ['first', 'second']) {
      const userId = await ctx.db.insert('users', { email: `synthetic-${name}@example.test` });
      await ctx.db.insert('portalMembers', { userId, role: 'enrollment', active: true, createdAt: date });
      ids.push(userId);
    }
    return ids;
  });
  return { t, first: t.withIdentity({ subject: userIds[0] }), second: t.withIdentity({ subject: userIds[1] }), userIds };
}
describe('closeout action identity and revisions', () => {
  it('replays a lost completion response after another supervisor reopens without re-signing', async () => {
    const { t, first, second } = await setup();
    const complete = { date, action: 'complete' as const, requestId: 'original-completion', expectedRevision: null, notes: 'Signed synthetic record' };
    const signed = await first.mutation(api.shiftCloseouts.save, complete);
    const reopened = await second.mutation(api.shiftCloseouts.save, { date, action: 'reopen', requestId: 'intentional-reopen', expectedRevision: signed.revision });
    const before = await t.run(ctx => ctx.db.get(signed.id));
    const history = await t.run(ctx => ctx.db.query('shiftCloseoutHistory').collect());
    expect(await first.mutation(api.shiftCloseouts.save, complete)).toEqual(signed);
    expect(await t.run(ctx => ctx.db.get(signed.id))).toEqual(before);
    expect(before).toMatchObject({ status: 'reopened', revision: reopened.revision });
    expect(await t.run(ctx => ctx.db.query('shiftCloseoutHistory').collect())).toEqual(history);
    expect(await t.run(ctx => ctx.db.query('shiftCloseoutActionReceipts').collect())).toHaveLength(2);
    await expect(first.mutation(api.shiftCloseouts.save, { ...complete, notes: 'Changed replay' })).rejects.toThrow('different details');
  });

  it('rejects an old notes draft and a distinct delayed completion using the old revision', async () => {
    const { t, first, second } = await setup();
    const initial = await first.mutation(api.shiftCloseouts.save, { date, action: 'save', requestId: 'initial', expectedRevision: null, notes: 'Original' });
    const updated = await second.mutation(api.shiftCloseouts.save, { date, action: 'save', requestId: 'newer', expectedRevision: initial.revision, notes: 'Newer notes' });
    for (const action of ['save', 'complete'] as const) {
      await expect(first.mutation(api.shiftCloseouts.save, { date, action, requestId: `stale-${action}`, expectedRevision: initial.revision, notes: 'Stale notes' })).rejects.toThrow('Another action changed');
    }
    expect(await t.run(ctx => ctx.db.get(initial.id))).toMatchObject({ notes: 'Newer notes', status: 'open', revision: updated.revision });
    expect(await t.run(ctx => ctx.db.query('shiftCloseoutHistory').collect())).toEqual([]);
    expect(await t.run(ctx => ctx.db.query('shiftCloseoutActionReceipts').collect())).toHaveLength(2);
  });

  it('replays reopen once and still requires current write authority for its receipt', async () => {
    const { t, first, userIds } = await setup();
    const signed = await first.mutation(api.shiftCloseouts.save, { date, action: 'complete', requestId: 'sign', expectedRevision: null });
    const input = { date, action: 'reopen' as const, requestId: 'reopen', expectedRevision: signed.revision };
    const reopened = await first.mutation(api.shiftCloseouts.save, input);
    expect(await first.mutation(api.shiftCloseouts.save, input)).toEqual(reopened);
    expect(await t.run(ctx => ctx.db.query('shiftCloseoutHistory').collect())).toHaveLength(2);
    await t.run(async ctx => {
      const member = await ctx.db.query('portalMembers').withIndex('by_user', q => q.eq('userId', userIds[0])).unique();
      await ctx.db.patch(member!._id, { role: 'viewer' });
    });
    await expect(first.mutation(api.shiftCloseouts.save, input)).rejects.toThrow('Insufficient permissions');
  });

  it('treats a pre-migration row as revision zero without replacing its signed history', async () => {
    const { t, first } = await setup();
    const id = await t.run(ctx => ctx.db.insert('shiftCloseouts', { date, status: 'open', notes: 'Legacy', acknowledgedBlockers: false,
      expected: 0, present: 0, late: 0, missing: 0, openExceptions: 0, criticalExceptions: 0, kioskWarnings: 0, createdAt: date, updatedAt: date }));
    await expect(first.mutation(api.shiftCloseouts.save, { date, action: 'save', requestId: 'incorrect-new', expectedRevision: null })).rejects.toThrow('Another action changed');
    const updated = await first.mutation(api.shiftCloseouts.save, { date, action: 'save', requestId: 'legacy-update', expectedRevision: 0, notes: 'Updated legacy' });
    expect(updated).toMatchObject({ id, revision: 1 });
  });
});
