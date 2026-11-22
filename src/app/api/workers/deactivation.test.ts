/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import convex from '@/lib/convex';
import { hasValidPortalSession } from '@/lib/portal-auth';
import { api } from '../../../../convex/_generated/api';
import schema from '../../../../convex/schema';
import { DELETE } from './route';

vi.mock('@/lib/convex', () => ({ default: { mutation: vi.fn() } }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: vi.fn() }));
const modules = import.meta.glob('../../../../convex/**/*.ts');
const request = (id: string) => new NextRequest(`https://example.test/api/workers?id=${id}`, { method: 'DELETE' });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(hasValidPortalSession).mockResolvedValue(true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function setup() {
  const t = convexTest(schema, modules);
  const fixture = await t.run(async ctx => {
    const date = new Date().toISOString();
    const users = await Promise.all((['admin', 'viewer'] as const).map(async role => {
      const userId = await ctx.db.insert('users', { name: role });
      await ctx.db.insert('portalMembers', { userId, role, active: true, createdAt: date });
      return userId;
    }));
    const worker = { name: 'Synthetic Worker', department: 'Assembly', active: true, enrolledAt: date };
    const id = await ctx.db.insert('workers', worker);
    const missingId = await ctx.db.insert('workers', worker);
    await ctx.db.delete(missingId);
    return { adminId: users[0], viewerId: users[1], id, missingId };
  });
  const admin = t.withIdentity({ subject: fixture.adminId });
  vi.mocked(convex.mutation).mockImplementation((ref, ...args) =>
    admin.mutation(ref as typeof api.workers.remove, args[0] as { id: typeof fixture.id }));
  return { t, ...fixture };
}

it('returns a JSON 404 for a worker record that no longer exists', async () => {
  const { t, id, missingId } = await setup();
  const response = await DELETE(request(missingId));
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: 'Worker not found' });
  expect(await t.run(ctx => ctx.db.get(id))).toMatchObject({ active: true });
  expect(await t.run(ctx => ctx.db.query('auditLog').collect())).toEqual([]);
});

it('returns and logs a safe error for a failed backend write', async () => {
  vi.mocked(convex.mutation).mockRejectedValue(new Error('PRIVATE_BACKEND_DIAGNOSTIC'));
  const response = await DELETE(request('worker'));
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: 'Failed to deactivate worker' });
  expect(console.error).toHaveBeenCalledWith('Worker deactivation failed:', expect.objectContaining({ type: 'Error' }));
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('PRIVATE_BACKEND_DIAGNOSTIC');
});

it('keeps deactivation admin-only at the route and backend and persists one successful write', async () => {
  const { t, id, viewerId } = await setup();
  vi.mocked(hasValidPortalSession).mockResolvedValueOnce(false);
  expect((await DELETE(request(id))).status).toBe(401);
  expect(hasValidPortalSession).toHaveBeenCalledWith(expect.any(NextRequest), ['admin']);
  expect(convex.mutation).not.toHaveBeenCalled();
  await expect(t.withIdentity({ subject: viewerId }).mutation(api.workers.remove, { id }))
    .rejects.toThrow('Insufficient permissions');
  await expect(t.mutation(api.workers.remove, { id })).rejects.toThrow('Unauthorized');
  expect(await t.run(ctx => ctx.db.get(id))).toMatchObject({ active: true });
  expect((await DELETE(request(id))).status).toBe(200);
  expect((await DELETE(request(id))).status).toBe(200);
  expect(await t.run(ctx => ctx.db.get(id))).toMatchObject({ active: false });
  expect(await t.run(ctx => ctx.db.query('auditLog').collect())).toMatchObject([
    { action: 'workers.remove', targetId: id },
  ]);
});
