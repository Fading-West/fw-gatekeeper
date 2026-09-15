/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { NextRequest } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { api } from '../../../../convex/_generated/api';
import schema from '../../../../convex/schema';
import convex from '@/lib/convex';
import { PATCH } from './route';

vi.mock('@/lib/convex', () => ({ default: { mutation: vi.fn() } }));
const modules = import.meta.glob('../../../../convex/**/*.ts');
beforeEach(() => vi.clearAllMocks());

async function setup(role: 'admin' | 'viewer' | 'enrollment' = 'admin') {
  const t = convexTest(schema, modules);
  const { userId, id } = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'schedule@example.test' });
    await ctx.db.insert('portalMembers', { userId, role, active: true, createdAt: '2026-09-01' });
    const id = await ctx.db.insert('schedules', {
      name: 'Day', days: '[1,2,3,4,5]', startTime: '06:00', endTime: '14:30',
      department: 'Assembly', active: true, createdAt: '2026-09-01',
    });
    return { userId, id };
  });
  const actor = t.withIdentity({ subject: userId });
  // Model the HTTP client's JSON serialization so undefined cannot masquerade
  // as an explicit department clear before the real mutation runs.
  vi.mocked(convex.mutation).mockImplementation((...call) => {
    const [ref, args = {}] = call;
    return actor.mutation(ref, JSON.parse(JSON.stringify(args)));
  });
  const patch = (fields: Record<string, unknown>) => PATCH(new NextRequest('https://example.test/api/schedules', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, ...fields }),
  }));
  return { t, actor, id, patch };
}

it.each([null, ''])('clears a schedule department sent as %j through PATCH and the real mutation', async department => {
  const { t, actor, id, patch } = await setup();
  expect((await patch({ department })).status).toBe(200);
  expect(await t.run(ctx => ctx.db.get(id))).not.toHaveProperty('department');
  expect((await actor.query(api.schedules.list, {}))[0].department).toBeNull();
});

it('preserves the department when omitted from an unrelated update', async () => {
  const { t, id, patch } = await setup();
  expect((await patch({ name: 'Renamed day shift' })).status).toBe(200);
  expect(await t.run(ctx => ctx.db.get(id))).toMatchObject({ name: 'Renamed day shift', department: 'Assembly' });
});

it('changes the department to a nonempty value', async () => {
  const { t, id, patch } = await setup();
  expect((await patch({ department: 'Packing' })).status).toBe(200);
  expect(await t.run(ctx => ctx.db.get(id))).toMatchObject({ department: 'Packing' });
});

it.each(['viewer', 'enrollment'] as const)('keeps department clears restricted from %s members', async role => {
  const { t, actor, id } = await setup(role);
  await expect(actor.mutation(api.schedules.update, { id, department: null })).rejects.toThrow('Insufficient permissions');
  expect(await t.run(ctx => ctx.db.get(id))).toMatchObject({ department: 'Assembly' });
});

it('rejects non-string department values instead of clearing the restriction', async () => {
  const { t, actor, id } = await setup();
  await expect(actor.mutation(api.schedules.update, { id, department: false as unknown as string })).rejects.toThrow();
  expect(await t.run(ctx => ctx.db.get(id))).toMatchObject({ department: 'Assembly' });
});
