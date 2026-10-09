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
it('rejects invalid time atomically and retains valid offline timestamp formats', async () => {
 const { t } = await setup();
 for (const timestamp of ['', ' ', 'bad', '2026-02-30T08:00:00', '2026-09-14T25:00:00', '2026-03-08T02:30:00']) {
  await expect(t.mutation(internal.recognitionAttempts.bulkIngestFromHttp, { attempts: [{ ...attempt, sourceAttemptId: 'first' }, { ...attempt, timestamp }] })).rejects.toThrow('Recognition timestamp');
 }
 expect(await t.run(ctx => ctx.db.query('recognitionAttempts').collect())).toHaveLength(0);
 for (const timestamp of ['2026-09-14T13:00:00Z', '2026-09-14 08:00:00-0500', attempt.timestamp]) await t.mutation(internal.recognitionAttempts.bulkIngestFromHttp, { attempts: [{ ...attempt, timestamp }] });
 expect(await t.run(ctx => ctx.db.query('recognitionAttempts').collect())).toHaveLength(3);
});
