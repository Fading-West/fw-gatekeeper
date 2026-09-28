/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { NextRequest } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';
import schema from '../../../../convex/schema';
import convex from '@/lib/convex';
import { GET } from './route';

vi.mock('@/lib/convex', () => ({ default: { query: vi.fn() } }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: vi.fn(async () => true) }));
const modules = import.meta.glob('../../../../convex/**/*.ts');
let test: ReturnType<typeof convexTest>;
const base = { kioskId: 'entry', timestamp: '2026-09-14T10:00:00', faceDetected: true,
  decision: 'accepted', threshold: 0.3, bestScore: 0.8, reviewed: true,
  reviewedLabel: 'confirmed', createdAt: '2026-09-14T10:00:00' };
beforeEach(async () => {
  test = convexTest(schema, modules);
  const user = await test.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'viewer@example.test' });
    await ctx.db.insert('portalMembers', { userId, role: 'viewer', active: true, createdAt: base.createdAt });
    for (let i = 0; i < 150; i++) await ctx.db.insert('recognitionAttempts', base);
    return userId;
  });
  const viewer = test.withIdentity({ subject: user });
  vi.mocked(convex.query).mockImplementation((name, args = {}) => viewer.query(name, args));
});
async function get(params: string) {
  const search = new URLSearchParams(params);
  if (!search.has('limit')) search.set('limit', '150');
  search.set('date', '2026-09-14');
  const response = await GET(new NextRequest(`https://example.test/api/recognition-attempts?${search}`));
  expect(response.status).toBe(200);
  return response.json();
}
it.each([
  ['decision=near_miss', { decision: 'near_miss' }],
  ['decision=rejected', { decision: 'rejected_liveness' }],
  ['confidence_band=low', { bestScore: 0.2 }],
  ['confidence_band=medium', { bestScore: 0.3 }],
  ['review_status=corrected', { reviewedLabel: 'corrected' }],
  ['review_status=ignored', { reviewedLabel: 'ignored' }],
  ['decision=near_miss&confidence_band=low&review_status=corrected', { decision: 'near_miss', bestScore: 0.2, reviewedLabel: 'corrected' }],
])('finds older matches beyond 150 nonmatches: %s', async (params, changes) => {
  const id = await test.run(ctx => ctx.db.insert('recognitionAttempts', { ...base, timestamp: '2026-09-14T08:00:00', ...changes }));
  const response = await get(params);
  expect(response.attempts.map((row: { id: string }) => row.id)).toEqual([id]);
  expect(response.summary.total).toBe(1);
});
it('keeps accepted aliases, missing review labels, score boundaries and returned-row summaries', async () => {
  const id = await test.run(ctx => ctx.db.insert('recognitionAttempts', { ...base, timestamp: '2026-09-14T11:00:00', decision: 'accepted_manual', bestScore: 0.45, reviewedLabel: undefined }));
  const response = await get('decision=accepted&confidence_band=high&review_status=confirmed&limit=1');
  expect(response.attempts).toHaveLength(1);
  expect(response.attempts[0].id).toBe(id);
  expect(response.summary.accepted).toBe(1);
});
it('retrieves exact older attempts despite incompatible list filters', async () => {
  const id = await test.run(ctx => ctx.db.insert('recognitionAttempts', { ...base, timestamp: '2026-09-14T08:00:00' }));
  const response = await get(`attempt_id=${id}&decision=near_miss&confidence_band=low&review_status=ignored`);
  expect(response.attempts.map((row: { id: string }) => row.id)).toEqual([id]);
  expect(response.summary.total).toBe(1);
});
it.each(['confirmed', 'corrected', 'ignored'])('excludes %s near misses from review backlog', async reviewedLabel => {
  await test.run(async ctx => {
    await ctx.db.insert('recognitionAttempts', { ...base, decision: 'near_miss', reviewedLabel });
    await ctx.db.insert('recognitionAttempts', { ...base, decision: 'near_miss', reviewed: false });
  });
  const response = await get('decision=near_miss');
  expect(response.attempts).toHaveLength(2);
  expect(response.summary.review_backlog).toBe(1);
});
