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
it('rejects invalid calibration metrics atomically and preserves negative cosine evidence', async () => {
 const { t } = await setup();
 for (const bad of [{ bestScore: NaN }, { threshold: -0.1 }, { bestScore: 4 }, { blur: -1 }, { imageQuality: Infinity }, { brightness: 256 }]) {
  await expect(t.mutation(internal.recognitionAttempts.bulkIngestFromHttp, { attempts: [attempt, { ...attempt, ...bad }] })).rejects.toThrow('Invalid recognition metric');
 }
 expect(await t.run(ctx => ctx.db.query('recognitionAttempts').collect())).toHaveLength(0);
 await expect(t.mutation(internal.recognitionAttempts.bulkIngestFromHttp, { attempts: [{ ...attempt, bestScore: -0.4, secondBestScore: -0.8, scoreMargin: 0.4, blur: 300 }] })).resolves.toMatchObject({ ingested: 1 });
});
