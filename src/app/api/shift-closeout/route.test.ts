/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { NextRequest } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { api } from '../../../../convex/_generated/api';
import schema from '../../../../convex/schema';
import convex from '@/lib/convex';
import { hasValidPortalSession } from '@/lib/portal-auth';
import { PATCH } from './route';

vi.mock('@/lib/convex', () => ({ default: { mutation: vi.fn() } }));
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
  // Match Convex HTTP serialization: undefined fields disappear on the wire.
  vi.mocked(convex.mutation).mockImplementation((...call) => {
    const [ref, args = {}] = call;
    // PATCH uses a generated reference, not the HTTP client's future references.
    return actor.mutation(ref as typeof api.shiftCloseouts.save, JSON.parse(JSON.stringify(args)));
  });
  const patch = (fields: Record<string, unknown>) => PATCH(new NextRequest('https://example.test/api/shift-closeout', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ date, ...fields }),
  }));
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
  expect(response.status).toBe(500);
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
