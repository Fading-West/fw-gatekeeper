/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';
const modules = import.meta.glob('./**/*.ts');
const date = '2026-09-03';
async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'synthetic-supervisor@example.test' });
    await ctx.db.insert('portalMembers', { userId, role: 'enrollment', active: true, createdAt: date });
    const kioskId = await ctx.db.insert('kiosks', { name: 'Synthetic gate', kioskId: 'synthetic-gate', type: 'entry', location: 'Synthetic', active: true });
    return { userId, kioskId };
  });
  return { t, actor: t.withIdentity({ subject: ids.userId }), ...ids };
}
async function acknowledge(actor: Awaited<ReturnType<typeof setup>>['actor'], action: 'save' | 'complete' = 'save') {
  const payload = await actor.query(api.shiftCloseouts.get, { date });
  return actor.mutation(api.shiftCloseouts.save, { date, action, notes: 'Synthetic blocker evidence reviewed', acknowledgedBlockers: true, blockerEvidence: payload.blocker_evidence });
}
describe('closeout acknowledgement is bound to reviewed evidence', () => {
  it('requires fresh acknowledgement when another kiosk replaces the same-count blocker', async () => {
    const { t, actor, kioskId } = await setup();
    const original = await actor.query(api.shiftCloseouts.get, { date });
    await acknowledge(actor);
    await t.run(async ctx => {
      await ctx.db.patch(kioskId, { active: false });
      await ctx.db.insert('kiosks', { name: 'Replacement synthetic gate', type: 'exit', location: 'Synthetic', active: true });
    });
    const changed = await actor.query(api.shiftCloseouts.get, { date });
    expect(changed.summary.kiosk_warnings).toBe(original.summary.kiosk_warnings);
    expect(changed.closeout).toMatchObject({ acknowledged_blockers: false, acknowledgement_stale: true });
    await expect(actor.mutation(api.shiftCloseouts.save, { date, action: 'complete', acknowledgedBlockers: true, blockerEvidence: original.blocker_evidence })).rejects.toThrow('blockers changed');
    expect(await t.run(ctx => ctx.db.query('shiftCloseoutHistory').collect())).toEqual([]);
    await acknowledge(actor, 'complete');
    expect((await actor.query(api.shiftCloseouts.get, { date })).closeout?.status).toBe('completed');
  });
  it('rejects a new recognition issue after the acknowledgement draft was loaded', async () => {
    const { t, actor } = await setup();
    const old = await actor.query(api.shiftCloseouts.get, { date });
    await t.run(ctx => ctx.db.insert('recognitionAttempts', { timestamp: `${date}T10:00:00`, kioskId: 'synthetic-gate', faceDetected: true, decision: 'near_miss', threshold: .45, reviewed: false, createdAt: date }));
    await expect(actor.mutation(api.shiftCloseouts.save, { date, action: 'save', acknowledgedBlockers: true, blockerEvidence: old.blocker_evidence, notes: 'Old evidence' })).rejects.toThrow('blockers changed');
    expect(await t.run(ctx => ctx.db.query('shiftCloseouts').collect())).toEqual([]);
  });
  it('does not inherit unbound legacy acknowledgements and preserves an unchanged bound acknowledgement', async () => {
    const { t, actor } = await setup();
    const id = await t.run(ctx => ctx.db.insert('shiftCloseouts', { date, status: 'open', notes: 'Legacy note', acknowledgedBlockers: true,
      expected: 0, present: 0, late: 0, missing: 0, openExceptions: 0, criticalExceptions: 0, kioskWarnings: 1, createdAt: date, updatedAt: date }));
    expect((await actor.query(api.shiftCloseouts.get, { date })).closeout?.acknowledged_blockers).toBe(false);
    await expect(actor.mutation(api.shiftCloseouts.save, { date, action: 'complete' })).rejects.toThrow('acknowledgement note');
    await acknowledge(actor);
    await actor.mutation(api.shiftCloseouts.save, { date, action: 'complete' });
    const signed = await t.run(ctx => ctx.db.get(id));
    await actor.mutation(api.shiftCloseouts.save, { date, action: 'complete', notes: 'Lost response retry' });
    expect(await t.run(ctx => ctx.db.get(id))).toEqual(signed);
  });
});
