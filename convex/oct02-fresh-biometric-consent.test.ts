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
it('rejects stale and future acknowledgements without recording enrollment or audit', async () => {
 const { t, admin } = await setup();
 const input = { name: 'Synthetic worker', faceEncoding: Array(512).fill(0.1) };
 for (const age of [11 * 60_000, -2 * 60_000]) {
  await expect(admin.mutation(api.workers.create, { ...input, consentAt: new Date(Date.now() - age).toISOString() })).rejects.toThrow('Biometric consent');
 }
 expect(await t.run(ctx => ctx.db.query('workers').collect())).toHaveLength(0);
 const result = await admin.mutation(api.workers.create, { ...input, consentAt: new Date().toISOString() });
 await expect(admin.mutation(api.workers.update, { id: result.id, faceEncoding: input.faceEncoding, consentAt: '2020-01-01T00:00:00Z' })).rejects.toThrow('Biometric consent');
 await expect(admin.mutation(api.workers.update, { id: result.id, department: 'New department' })).resolves.toEqual({ ok: true });
});
