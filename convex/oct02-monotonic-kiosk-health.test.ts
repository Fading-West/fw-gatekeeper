/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { expect, it } from 'vitest';
import schema from './schema';
import { api, internal } from './_generated/api';
const modules = import.meta.glob('./**/*.ts');
const attempt = { kioskId: 'synthetic-entry', timestamp: '2026-09-14T08:00:00', faceDetected: true, decision: 'accepted', threshold: 0.45, bestScore: 0.8 };
async function setup() {
 const t = convexTest(schema, modules);
 const userId = await t.run(async ctx => {
  const id = await ctx.db.insert('users', { email: 'synthetic-admin@example.test' });
  await ctx.db.insert('portalMembers', { userId: id, role: 'admin', active: true, createdAt: new Date().toISOString() });
  return id;
 });
 return { t, admin: t.withIdentity({ subject: userId }), userId };
}
it('keeps the latest fault and watermark across out-of-order requests', async () => {
 const { t } = await setup();
 const newer = new Date(Date.now() - 60_000).toISOString();
 const older = new Date(Date.now() - 120_000).toISOString();
 const id = await t.run(ctx => ctx.db.insert('kiosks', { name: 'Synthetic', kioskId: attempt.kioskId, type: 'entry', location: '', active: true }));
 await t.mutation(internal.kiosks.updateLastSyncFromHttp, { kioskId: attempt.kioskId, lastSync: newer, health: { cameraOk: false, reportedAt: newer } });
 expect(await t.mutation(internal.kiosks.updateLastSyncFromHttp, { kioskId: attempt.kioskId, lastSync: older, health: { cameraOk: true, reportedAt: older } })).toEqual({ updated: true });
 expect(await t.run(ctx => ctx.db.get(id))).toMatchObject({ lastSync: newer, health: { cameraOk: false } });
 await expect(t.mutation(internal.kiosks.updateLastSyncFromHttp, { kioskId: attempt.kioskId, lastSync: 'invalid' })).rejects.toThrow('Kiosk sync time');
});
