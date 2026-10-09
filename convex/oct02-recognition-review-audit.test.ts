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
it('audits the authenticated operator and both review states atomically', async () => {
 const { t, admin, userId } = await setup();
 const result = await t.mutation(internal.recognitionAttempts.bulkIngestFromHttp, { attempts: [attempt] });
 await expect(t.mutation(api.recognitionAttempts.updateReview, { id: result.ids[0], reviewed: true })).rejects.toThrow('Unauthorized');
 await admin.mutation(api.recognitionAttempts.updateReview, { id: result.ids[0], reviewed: true, reviewedLabel: 'confirmed', reviewedNote: 'Checked scan' });
 await admin.mutation(api.recognitionAttempts.updateReview, { id: result.ids[0], reviewed: false });
 const audits = await t.run(ctx => ctx.db.query('auditLog').collect());
 expect(audits).toHaveLength(2);
 expect(audits[0]).toMatchObject({ actorUserId: userId, action: 'recognition.review', targetId: result.ids[0] });
 expect(JSON.parse(audits[1].details!)).toMatchObject({ before: { reviewed: true, note: 'Checked scan' }, after: { reviewed: false } });
});
