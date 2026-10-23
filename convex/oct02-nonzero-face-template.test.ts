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
import { isSupportedEncoding } from '../src/lib/encoding';
it('rejects unusable vectors at both enrollment boundaries and flags legacy zero rows', async () => {
 const { admin, t } = await setup();
 for (const vector of [Array(512).fill(0), Array(512).fill(Number.MAX_VALUE)]) {
  expect(isSupportedEncoding(vector)).toBe(false);
  await expect(admin.mutation(api.workers.create, { name: 'Synthetic worker', faceEncoding: vector, consentAt: new Date().toISOString() })).rejects.toThrow('faceEncoding');
 }
 expect(isSupportedEncoding(Array(512).fill(0.1))).toBe(true);
 await t.run(ctx => ctx.db.insert('workers', { name: 'Legacy zero', active: true, department: '', enrolledAt: '2026-09-14', faceEncoding: Array(512).fill(0) }));
 expect(await admin.query(api.workers.list, {})).toMatchObject([{ encoding_status: 'invalid', has_face_encoding: false }]);
});
