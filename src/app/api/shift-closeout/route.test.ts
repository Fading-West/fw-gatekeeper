/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import type { FunctionReference } from 'convex/server';
import { NextRequest } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { api } from '../../../../convex/_generated/api';
import schema from '../../../../convex/schema';
import convex from '@/lib/convex';
import { hasValidPortalSession } from '@/lib/portal-auth';
import { PATCH } from './route';

vi.mock('@/lib/convex', () => ({ default: { mutation: vi.fn(), query: vi.fn() } }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: vi.fn() }));
const modules = import.meta.glob('../../../../convex/**/*.ts');
const date = '2026-09-10';
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hasValidPortalSession).mockResolvedValue(true);
});

async function setup(blocked = false) {
  const t = convexTest(schema, modules);
  const { userId, id } = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'closeout@example.test' });
    await ctx.db.insert('portalMembers', { userId, role: 'enrollment', active: true, createdAt: date });
    const id = await ctx.db.insert('shiftCloseouts', {
      date, status: 'open', notes: 'Existing notes', supervisorName: 'Supervisor',
      acknowledgedBlockers: true, expected: 0, present: 0, late: 0, missing: 0,
      openExceptions: 0, criticalExceptions: 0, kioskWarnings: 0, createdAt: date, updatedAt: date,
    });
    if (blocked) await ctx.db.insert('kiosks', { name: 'Offline', type: 'entry', location: 'Gate', active: true });
    return { userId, id };
  });
  const actor = t.withIdentity({ subject: userId });
  const evidence = (await actor.query(api.shiftCloseouts.get, { date })).blocker_evidence;
  await t.run(ctx => ctx.db.patch(id, { acknowledgedBlockerEvidence: evidence }));
  // Match Convex HTTP serialization: undefined fields disappear on the wire.
  vi.mocked(convex.mutation).mockImplementation((...call) => {
    const [ref, args = {}] = call;
    // PATCH uses a generated reference, not the HTTP client's future references.
    return actor.mutation(ref as typeof api.shiftCloseouts.save, JSON.parse(JSON.stringify(args)));
  });
  vi.mocked(convex.query).mockImplementation((...call) => {
    const [ref, args = {}] = call;
    return actor.query(ref as FunctionReference<'query'>, JSON.parse(JSON.stringify(args)));
  });
  let request = 0;
  const patch = async (fields: Record<string, unknown>) => {
    const current = await actor.query(api.shiftCloseouts.get, { date });
    return PATCH(new NextRequest('https://example.test/api/shift-closeout', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ date, request_id: `route-fixture-${++request}`, expected_revision: current.closeout?.revision ?? 0, blocker_evidence: evidence, ...fields }),
    }));
  };
  return { t, id, patch };
}

it.each(['', '   '])('clears notes and supervisor name when explicitly sent as %j', async value => {
  const { t, id, patch } = await setup();
  expect((await patch({ notes: value, supervisor_name: value })).status).toBe(200);
  const saved = await t.run(ctx => ctx.db.get(id));
  expect(saved).not.toHaveProperty('notes');
  expect(saved).not.toHaveProperty('supervisorName');
  expect(saved?.acknowledgedBlockers).toBe(true);
});

it('preserves omitted fields and supports camelCase updates and clears', async () => {
  const { t, id, patch } = await setup();
  expect((await patch({ supervisorName: '  Updated  ' })).status).toBe(200);
  expect(await t.run(ctx => ctx.db.get(id))).toMatchObject({ supervisorName: 'Updated', notes: 'Existing notes', acknowledgedBlockers: true });
  expect((await patch({ supervisorName: '', acknowledgedBlockers: false })).status).toBe(200);
  const saved = await t.run(ctx => ctx.db.get(id));
  expect(saved).not.toHaveProperty('supervisorName');
  expect(saved).toMatchObject({ notes: 'Existing notes', acknowledgedBlockers: false });
});

it('uses an explicit snake-case clear instead of falling back to a camelCase value', async () => {
  const { t, id, patch } = await setup();
  expect((await patch({ supervisor_name: '', supervisorName: 'Fallback' })).status).toBe(200);
  expect(await t.run(ctx => ctx.db.get(id))).not.toHaveProperty('supervisorName');
});

it('passes an explicit note clear to blocker validation instead of silently keeping old notes', async () => {
  const { t, id, patch } = await setup(true);
  const response = await patch({ action: 'complete', notes: '', acknowledged_blockers: true });
  expect(response.status).toBe(409);
  expect((await response.json()).error).toContain('acknowledgement note');
  expect(await t.run(ctx => ctx.db.get(id))).toMatchObject({ status: 'open', notes: 'Existing notes' });
});

it.each([{ notes: null }, { notes: false }, { supervisor_name: 123 }, { acknowledged_blockers: 'false' }])('rejects invalid field types %j without writing', async fields => {
  const { t, id, patch } = await setup();
  expect((await patch(fields)).status).toBe(400);
  expect(convex.mutation).not.toHaveBeenCalled();
  expect(await t.run(ctx => ctx.db.get(id))).toMatchObject({ notes: 'Existing notes', supervisorName: 'Supervisor', acknowledgedBlockers: true });
});

it('keeps writes protected by the portal role check', async () => {
  const { patch } = await setup();
  vi.mocked(hasValidPortalSession).mockResolvedValue(false);
  expect((await patch({ notes: '' })).status).toBe(401);
  expect(convex.mutation).not.toHaveBeenCalled();
  expect(hasValidPortalSession).toHaveBeenCalledWith(expect.any(NextRequest), ['admin', 'enrollment']);
});

// A malformed explicit intent must never turn into a different persisted action.
it.each([null, false, 0, 123, '', '   ', [], {}, ['complete']].map(action => ({ action })))('rejects explicit malformed action $action without changing closeout evidence', async ({ action }) => {
  const { t, id, patch } = await setup();
  const before = await t.run(ctx => ctx.db.get(id));
  const response = await patch({ action, notes: 'Must not be saved' });
  const after = await t.run(async ctx => ({
    closeout: await ctx.db.get(id),
    receipts: await ctx.db.query('shiftCloseoutActionReceipts').collect(),
    history: await ctx.db.query('shiftCloseoutHistory').collect(),
    audit: await ctx.db.query('auditLog').collect(),
  }));
  expect(after).toEqual({ closeout: before, receipts: [], history: [], audit: [] });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'action must be save, complete, or reopen' });
  expect(convex.mutation).not.toHaveBeenCalled();
});

it('continues to default an omitted action to save', async () => {
  const { t, id, patch } = await setup();
  expect((await patch({ notes: 'Intentional save' })).status).toBe(200);
  expect(await t.run(ctx => ctx.db.get(id))).toMatchObject({ notes: 'Intentional save', revision: 1 });
});
