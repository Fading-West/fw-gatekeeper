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
it('never presents invalid or future sync timestamps as a healthy fleet', async () => {
 const { t } = await setup();
 for (const lastSync of ['invalid', new Date(Date.now() + 86_400_000).toISOString()]) {
  const id = await t.run(ctx => ctx.db.insert('kiosks', { name: 'Synthetic', type: 'entry', location: '', active: true, lastSync, health: { cameraOk: true, modelOk: true, reportedAt: new Date().toISOString() } }));
  const response = await t.fetch('/api/public/kiosk-health');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: 'degraded', kiosks: { offline: 1, online: 0 } });
  await t.run(ctx => ctx.db.delete(id));
 }
});
