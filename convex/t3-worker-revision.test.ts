/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { expect, it } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
const modules = import.meta.glob('./**/*.ts');
it('rejects a stale identity draft without changing the worker or recording an audit', async () => {
  const t = convexTest(schema, modules);
  const { userId, id } = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'synthetic@example.invalid' });
    await ctx.db.insert('portalMembers', { userId, role: 'admin', active: true, createdAt: '2026-10-02T00:00:00Z' });
    const id = await ctx.db.insert('workers', { name: 'Synthetic Worker', employeeId: 'S-1', department: 'Old', active: true, enrolledAt: '2026-10-02T00:00:00Z' });
    return { userId, id };
  });
  const admin = t.withIdentity({ subject: userId });
  const initial = (await admin.query(api.workers.get, { id }))!;
  await admin.mutation(api.workers.update, { id, department: 'Current', expectedIdentityRevision: initial.identity_revision });
  await expect(admin.mutation(api.workers.update, { id, name: 'Old editor', department: 'Old', expectedIdentityRevision: initial.identity_revision })).rejects.toThrow('Worker identity changed');
  await expect(admin.mutation(api.workers.update, { id, department: 'No revision' })).rejects.toThrow('Worker identity changed');
  expect(await t.run(ctx => ctx.db.get(id))).toMatchObject({ name: 'Synthetic Worker', department: 'Current' });
  expect((await t.run(ctx => ctx.db.query('auditLog').collect())).length).toBe(1);
  const current = (await admin.query(api.workers.get, { id }))!;
  await admin.mutation(api.workers.update, { id, name: 'Reviewed editor', expectedIdentityRevision: current.identity_revision });
  expect((await admin.query(api.workers.get, { id }))?.name).toBe('Reviewed editor');
});
