/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { expect, it } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
const modules = import.meta.glob('./**/*.ts');
it('protects legacy schedules from stale update/remove and permits an explicit refreshed retry', async () => {
  const t = convexTest(schema, modules);
  const { id, userId } = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', {});
    await ctx.db.insert('portalMembers', { userId, role: 'admin', active: true, createdAt: '2026-10-02' });
    const id = await ctx.db.insert('schedules', { name: 'Synthetic legacy', days: '[1]', startTime: '06:00', endTime: '14:30', active: true, createdAt: '2026-10-02' });
    return { id, userId };
  });
  const admin = t.withIdentity({ subject: userId });
  expect((await admin.query(api.schedules.list, {}))[0].revision).toBe(0);
  await admin.mutation(api.schedules.update, { id, expectedRevision: 0, endTime: '15:00' });
  await expect(admin.mutation(api.schedules.update, { id, expectedRevision: 0, name: 'Stale', endTime: '14:30' })).rejects.toThrow('Schedule changed');
  await expect(admin.mutation(api.schedules.remove, { id, expectedRevision: 0 })).rejects.toThrow('Schedule changed');
  expect(await t.run(ctx => ctx.db.get(id))).toMatchObject({ name: 'Synthetic legacy', endTime: '15:00', active: true, revision: 1 });
  await admin.mutation(api.schedules.update, { id, expectedRevision: 0, endTime: '15:00' }); // lost-response no-op retry
  await admin.mutation(api.schedules.remove, { id, expectedRevision: 1 });
  await admin.mutation(api.schedules.remove, { id, expectedRevision: 1 });
  await expect(admin.mutation(api.schedules.update, { id, expectedRevision: 2, name: 'Removed editor' })).rejects.toThrow('removed');
  expect(await t.run(ctx => ctx.db.get(id))).toMatchObject({ active: false, revision: 2 });
});
