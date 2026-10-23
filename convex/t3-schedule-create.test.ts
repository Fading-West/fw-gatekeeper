/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { expect, it } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
const modules = import.meta.glob('./**/*.ts');
const input = { name: 'Synthetic schedule', days: '[1,2]', startTime: '06:00', endTime: '14:30', requestId: 'synthetic-request' };
it('replays one creation receipt without duplicating or restoring a later removed schedule', async () => {
  const t = convexTest(schema, modules);
  const userId = await t.run(async ctx => { const id = await ctx.db.insert('users', { email: 'synthetic@example.invalid' }); await ctx.db.insert('portalMembers', { userId: id, role: 'admin', active: true, createdAt: '2026-10-02' }); return id; });
  const admin = t.withIdentity({ subject: userId });
  const [first, retry] = await Promise.all([admin.mutation(api.schedules.create, input), admin.mutation(api.schedules.create, input)]);
  expect(retry).toEqual(first);
  expect(await admin.query(api.schedules.list, {})).toHaveLength(1);
  await expect(admin.mutation(api.schedules.create, { ...input, name: 'Conflicting' })).rejects.toThrow('different schedule');
  await admin.mutation(api.schedules.remove, { id: first.id, expectedRevision: 0 });
  expect(await admin.mutation(api.schedules.create, input)).toEqual(first);
  expect(await admin.query(api.schedules.list, {})).toHaveLength(0);
  await admin.mutation(api.schedules.create, { ...input, requestId: 'intentional-new-request' });
  expect(await admin.query(api.schedules.list, {})).toHaveLength(1);
});
it.each(['viewer', 'enrollment'] as const)('rejects schedule creation by %s', async role => {
  const t = convexTest(schema, modules);
  const id = await t.run(async ctx => { const id = await ctx.db.insert('users', {}); await ctx.db.insert('portalMembers', { userId: id, role, active: true, createdAt: '2026-10-02' }); return id; });
  await expect(t.withIdentity({ subject: id }).mutation(api.schedules.create, input)).rejects.toThrow('Insufficient permissions');
  expect(await t.run(ctx => ctx.db.query('schedules').collect())).toEqual([]);
});
