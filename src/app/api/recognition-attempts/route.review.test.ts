/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import type { FunctionReference } from 'convex/server';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import schema from '../../../../convex/schema';
import { api } from '../../../../convex/_generated/api';
import convex from '@/lib/convex';
import { GET, PATCH } from './route';

vi.mock('@/lib/convex', () => ({ default: { query: vi.fn(), mutation: vi.fn() } }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: vi.fn(async () => true) }));
const modules = import.meta.glob('../../../../convex/**/*.ts');
afterEach(() => vi.useRealTimers());
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

async function patch(body: Record<string, unknown>) {
  // Ordinary fixtures submit the version they just read, as the Lab does.
  if (!Object.hasOwn(body, 'review_version')) {
    const current = await admin.query(api.recognitionAttempts.getById, { id: attemptId as any });
    body = { ...body, review_version: current?.review_version };
  }
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

it.each([undefined, null, '', '   ', 42, {}])('requires a current view before writing: %j', async review_version => {
  const before = await test.run(ctx => ctx.db.get(attemptId as any));
  expect((await patch({ id: attemptId, review_status: 'confirmed', review_version })).status).toBe(409);
  expect(await test.run(ctx => ctx.db.get(attemptId as any))).toEqual(before);
  expect(await test.run(ctx => ctx.db.query('auditLog').collect())).toEqual([]);
});

it('accepts the refreshed version after a conflict and keeps prior review audits', async () => {
  const original = await admin.query(api.recognitionAttempts.getById, { id: attemptId as any });
  await patch({ id: attemptId, review_status: 'corrected' });
  expect((await patch({ id: attemptId, review_status: 'confirmed', review_version: original?.review_version })).status).toBe(409);
  expect((await patch({ id: attemptId, review_status: 'confirmed' })).status).toBe(200);
  expect(await reviewStatus()).toBe('confirmed');
  expect(await test.run(ctx => ctx.db.query('auditLog').collect())).toHaveLength(2);
});

it.each(['confirmed', 'corrected', 'ignored'])('stores %s reviews', async status => {
  expect((await patch({ id: attemptId, review_status: status })).status).toBe(200);
  expect(await reviewStatus()).toBe(status);
  expect((await patch({ id: attemptId, review_status: 'unreviewed' })).status).toBe(200);
  expect(await reviewStatus()).toBe('unreviewed');
});

it('rejects unknown labels sent directly to the Convex mutation', async () => {
  await expect(admin.mutation(api.recognitionAttempts.updateReview, { id: attemptId as any, expectedReviewVersion: (await admin.query(api.recognitionAttempts.getById, { id: attemptId as any }))!.review_version, reviewedLabel: 'pending' }))
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
  await expect(admin.mutation(api.recognitionAttempts.updateReview, { id: attemptId as any, expectedReviewVersion: (await admin.query(api.recognitionAttempts.getById, { id: attemptId as any }))!.review_version, reviewedLabel: label }))
    .rejects.toThrow('reviewedLabel must be one of');
});

it.each(['confirmed', 'unreviewed'])('does not let a stale %s action overwrite a newer correction', async reviewStatus => {
  const firstView = await GET(new NextRequest(`https://example.test/api/recognition-attempts?date=2026-09-14&attempt_id=${attemptId}`));
  const seen = (await firstView.json()).attempts[0];
  const otherUser = await test.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'second-operator@example.test' });
    await ctx.db.insert('portalMembers', { userId, role: 'enrollment', active: true, createdAt: '2026-09-14T09:00:00' });
    return userId;
  });
  await test.withIdentity({ subject: otherUser }).mutation(api.recognitionAttempts.updateReview, {
    id: attemptId as any,
    ...(seen.review_version ? { expectedReviewVersion: seen.review_version } : {}),
    reviewedLabel: 'corrected', reviewedNote: 'Confirmed a wrong-person match',
  });
  const before = await test.run(ctx => ctx.db.get(attemptId as any));
  const audits = await test.run(ctx => ctx.db.query('auditLog').collect());
  const response = await patch({ id: attemptId, review_status: reviewStatus, review_version: seen.review_version ?? 'original-unreviewed-state' });
  expect(response.status).toBe(409);
  expect(await test.run(ctx => ctx.db.get(attemptId as any))).toEqual(before);
  expect(await test.run(ctx => ctx.db.query('auditLog').collect())).toEqual(audits);
});

it.each(['label', 'note'])('detects a %s change even when both writes have identical timestamps', async field => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-14T18:00:00Z'));
  await admin.mutation(api.recognitionAttempts.updateReview, { id: attemptId as any, expectedReviewVersion: (await admin.query(api.recognitionAttempts.getById, { id: attemptId as any }))!.review_version, reviewedLabel: 'confirmed', reviewedNote: 'First review' });
  const original = await admin.query(api.recognitionAttempts.getById, { id: attemptId as any });
  await admin.mutation(api.recognitionAttempts.updateReview, {
    id: attemptId as any, expectedReviewVersion: original!.review_version,
    ...(field === 'label' ? { reviewedLabel: 'corrected' } : { reviewedNote: 'Found a wrong-person match' }),
  });
  const changed = await admin.query(api.recognitionAttempts.getById, { id: attemptId as any });
  expect(changed?.updated_at).toBe(original?.updated_at);
  expect(changed?.reviewed_at).toBe(original?.reviewed_at);
  expect(changed?.review_version).toMatch(/^[a-f0-9]{64}$/);
  expect(changed?.review_version).not.toBe(original?.review_version);
  await expect(admin.mutation(api.recognitionAttempts.updateReview, {
    id: attemptId as any, expectedReviewVersion: original?.review_version, reviewed: false,
  })).rejects.toThrow('This recognition review changed');
  expect(await admin.query(api.recognitionAttempts.getById, { id: attemptId as any })).toEqual(changed);
  expect(await test.run(ctx => ctx.db.query('auditLog').collect())).toHaveLength(2);
});

it('rejects stale writes after a same-millisecond review changes away and back', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-14T18:00:00Z'));
  await patch({ id: attemptId, review_status: 'confirmed' });
  const original = await admin.query(api.recognitionAttempts.getById, { id: attemptId as any });
  await patch({ id: attemptId, review_status: 'corrected' });
  await patch({ id: attemptId, review_status: 'confirmed' });
  const latest = await admin.query(api.recognitionAttempts.getById, { id: attemptId as any });
  expect(latest).toMatchObject({ updated_at: original!.updated_at, reviewed_at: original!.reviewed_at, reviewed_label: original!.reviewed_label });
  expect(latest!.review_version).not.toBe(original!.review_version);
  expect((await patch({ id: attemptId, review_status: 'ignored', review_version: original!.review_version })).status).toBe(409);
  expect(await test.run(ctx => ctx.db.query('auditLog').collect())).toHaveLength(3);
});

it('requires the version at the Convex boundary too', async () => {
  const before = await test.run(ctx => ctx.db.get(attemptId as any));
  await expect(admin.mutation(api.recognitionAttempts.updateReview, { id: attemptId as any, reviewed: true })).rejects.toThrow('This recognition review changed');
  expect(await test.run(ctx => ctx.db.get(attemptId as any))).toEqual(before);
  expect(await test.run(ctx => ctx.db.query('auditLog').collect())).toEqual([]);
});
