import { ConvexError } from 'convex/values';
import { NextRequest } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';
import convex from '@/lib/convex';
import { PATCH } from './route';
vi.mock('@/lib/convex', () => ({ default: { mutation: vi.fn() } }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: vi.fn(async () => true) }));
beforeEach(() => vi.clearAllMocks());
const request = (extra: object) => new NextRequest('http://localhost/api/shift-closeout', { method: 'PATCH', body: JSON.stringify({ date: '2026-09-03', action: 'save', ...extra }) });
it.each([{}, { request_id: 'id' }, { request_id: 'id', expected_revision: -1 }, { request_id: 'id', expected_revision: 1.5 }])('rejects missing or invalid action identity %#', async extra => {
  expect((await PATCH(request(extra))).status).toBe(400);
  expect(convex.mutation).not.toHaveBeenCalled();
});
it('forwards a new-record revision and reports recoverable concurrent edits', async () => {
  vi.mocked(convex.mutation).mockRejectedValue(new ConvexError({ code: 'CLOSEOUT_REVISION_CONFLICT', message: 'Reconcile draft' }));
  const response = await PATCH(request({ request_id: 'synthetic-save', expected_revision: null }));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ code: 'CLOSEOUT_REVISION_CONFLICT', error: 'Reconcile draft' });
  expect(vi.mocked(convex.mutation).mock.calls[0][1]).toMatchObject({ requestId: 'synthetic-save', expectedRevision: null });
});
it.each([undefined, {}, { id: 'synthetic', status: 'open', revision: 1, requestId: 'different', actorUserId: 'synthetic-actor' }])('does not report malformed mutation acknowledgements as successful %#', async result => {
  vi.mocked(convex.mutation).mockResolvedValue(result);
  expect((await PATCH(request({ request_id: 'synthetic-save', expected_revision: null }))).status).toBe(502);
});
