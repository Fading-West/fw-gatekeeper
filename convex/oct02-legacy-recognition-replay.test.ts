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
it('acknowledges exact legacy retries across transactions without collapsing changed evidence', async () => {
 const { t } = await setup();
 expect(await t.mutation(internal.recognitionAttempts.bulkIngestFromHttp, { attempts: [attempt] })).toMatchObject({ ingested: 1 });
 expect(await t.mutation(internal.recognitionAttempts.bulkIngestFromHttp, { attempts: [attempt] })).toMatchObject({ ingested: 0, skipped: 1 });
 expect(await t.mutation(internal.recognitionAttempts.bulkIngestFromHttp, { attempts: [{ ...attempt, bestScore: 0.9 }] })).toMatchObject({ ingested: 1 });
 for (const sourceAttemptId of ['separate-one', 'separate-two']) await t.mutation(internal.recognitionAttempts.bulkIngestFromHttp, { attempts: [{ ...attempt, sourceAttemptId }] });
 expect(await t.run(ctx => ctx.db.query('recognitionAttempts').collect())).toHaveLength(4);
});

it('preserves differing legacy evidence in one batch and deduplicates exact copies', async () => {
 const { t } = await setup();
 expect(await t.mutation(internal.recognitionAttempts.bulkIngestFromHttp, { attempts: [attempt, { ...attempt, bestScore: 0.9 }, attempt] })).toMatchObject({ ingested: 2, skipped: 1 });
});
