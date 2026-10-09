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
it('ignores forged device reviews and preserves authorized review on retry', async () => {
 const { t } = await setup();
 const input = { ...attempt, sourceAttemptId: 'authority-test', reviewed: true, reviewedLabel: 'ignored', reviewedNote: 'hide this', reviewedAt: '2026-09-14T09:00:00Z' };
 const result = await t.mutation(internal.recognitionAttempts.bulkIngestFromHttp, { attempts: [input] });
 expect(await t.run(ctx => ctx.db.get(result.ids[0]))).toMatchObject({ reviewed: false });
 const row = await t.run(ctx => ctx.db.get(result.ids[0]));
 expect(row?.reviewedNote).toBeUndefined();
 await t.run(ctx => ctx.db.patch(result.ids[0], { reviewed: true, reviewedNote: 'Authorized review' }));
 await t.mutation(internal.recognitionAttempts.bulkIngestFromHttp, { attempts: [input] });
 expect((await t.run(ctx => ctx.db.get(result.ids[0])))?.reviewedNote).toBe('Authorized review');
});
