/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import type { FunctionReference } from 'convex/server';
import { NextRequest } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';
import schema from '../../../../convex/schema';
import { api } from '../../../../convex/_generated/api';
import convex from '@/lib/convex';
import { GET, PATCH } from './route';

vi.mock('@/lib/convex', () => ({ default: { query: vi.fn(), mutation: vi.fn() } }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: vi.fn(async () => true) }));
const modules = import.meta.glob('../../../../convex/**/*.ts');
let test: ReturnType<typeof convexTest>;
let admin: ReturnType<ReturnType<typeof convexTest>['withIdentity']>;
let attemptId: string;

beforeEach(async () => {
  test = convexTest(schema, modules);
  const ids = await test.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'admin@example.test' });
    await ctx.db.insert('portalMembers', { userId, role: 'admin', active: true, createdAt: '2026-09-14T09:00:00' });
    const attemptId = await ctx.db.insert('recognitionAttempts', {
      kioskId: 'entry', timestamp: '2026-09-14T10:00:00', faceDetected: true, decision: 'near_miss',
      threshold: 0.3, bestScore: 0.29, reviewed: false, createdAt: '2026-09-14T10:00:00',
    });
    return { userId, attemptId };
  });
  attemptId = ids.attemptId;
  admin = test.withIdentity({ subject: ids.userId });
  vi.mocked(convex.query).mockImplementation((name, args = {}) => admin.query(name as FunctionReference<'query'>, args));
  vi.mocked(convex.mutation).mockImplementation(((name: any, args: any = {}) => admin.mutation(name, args)) as any);
});

function patch(body: unknown) {
  return PATCH(new NextRequest('https://example.test/api/recognition-attempts', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
}

async function reviewStatus() {
  const response = await GET(new NextRequest(`https://example.test/api/recognition-attempts?date=2026-09-14&attempt_id=${attemptId}`));
  return (await response.json()).attempts[0].review_status;
}

it.each(['pending', 'Confirmed', 'approved'])('rejects unknown review status %s without marking the attempt reviewed', async status => {
  const response = await patch({ id: attemptId, review_status: status });
  expect(response.status).toBe(400);
  const stored = await test.run(ctx => ctx.db.get(attemptId as any)) as { reviewed: boolean; reviewedLabel?: string };
  expect(stored.reviewed).toBe(false);
  expect(stored.reviewedLabel).toBeUndefined();
  expect(await reviewStatus()).toBe('unreviewed');
});

it.each(['confirmed', 'corrected', 'ignored'])('stores %s reviews', async status => {
  expect((await patch({ id: attemptId, review_status: status })).status).toBe(200);
  expect(await reviewStatus()).toBe(status);
  expect((await patch({ id: attemptId, review_status: 'unreviewed' })).status).toBe(200);
  expect(await reviewStatus()).toBe('unreviewed');
});

it('rejects unknown labels sent directly to the Convex mutation', async () => {
  await expect(admin.mutation(api.recognitionAttempts.updateReview, { id: attemptId as any, reviewedLabel: 'pending' }))
    .rejects.toThrow('reviewedLabel must be one of');
  const stored = await test.run(ctx => ctx.db.get(attemptId as any)) as { reviewed: boolean };
  expect(stored.reviewed).toBe(false);
});

const malformedStatuses: unknown[] = [42, false, null, [], {}, '', '   '];
it.each(['review_status', 'reviewStatus'].flatMap(field => malformedStatuses.map(value => ({ field, value }))))(
  'rejects malformed $field $value without changing the stored review', async ({ field, value }) => {
    const before = await test.run(ctx => ctx.db.get(attemptId as any));
    const response = await patch({ id: attemptId, [field]: value });
    expect(response.status).toBe(400);
    expect(await test.run(ctx => ctx.db.get(attemptId as any))).toEqual(before);
    expect(await reviewStatus()).toBe('unreviewed');
  });

it('still confirms an attempt when the review status is omitted', async () => {
  expect((await patch({ id: attemptId })).status).toBe(200);
  expect(await reviewStatus()).toBe('confirmed');
});

it.each(['', '   '])('rejects blank label %j sent directly to the Convex mutation', async label => {
  await expect(admin.mutation(api.recognitionAttempts.updateReview, { id: attemptId as any, reviewedLabel: label }))
    .rejects.toThrow('reviewedLabel must be one of');
});
