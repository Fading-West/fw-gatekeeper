import { ConvexError } from 'convex/values';
import { NextRequest } from 'next/server';
import { expect, it, vi } from 'vitest';
import convex from '@/lib/convex';
import { PATCH } from './route';
vi.mock('@/lib/convex', () => ({ default: { mutation: vi.fn() } }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: vi.fn(async () => true) }));
it('forwards the reviewed blocker token and returns a refreshable conflict', async () => {
  vi.mocked(convex.mutation).mockRejectedValue(new ConvexError({ code: 'CLOSEOUT_BLOCKERS_CHANGED', message: 'Review new blockers' }));
  const response = await PATCH(new NextRequest('http://localhost/api/shift-closeout', { method: 'PATCH', body: JSON.stringify({ date: '2026-09-03', action: 'complete', notes: 'Reviewed old evidence', acknowledged_blockers: true, blocker_evidence: 'synthetic-old-token' }) }));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ code: 'CLOSEOUT_BLOCKERS_CHANGED', error: 'Review new blockers' });
  expect(vi.mocked(convex.mutation).mock.calls[0][1]).toMatchObject({ blockerEvidence: 'synthetic-old-token' });
});

it('refreshes a completion draft that was clear before new blockers appeared', async () => {
  vi.mocked(convex.mutation).mockRejectedValue(new ConvexError({ code: 'CLOSEOUT_BLOCKERS_CHANGED', message: 'Refresh current evidence' }));
  const response = await PATCH(new NextRequest('http://localhost/api/shift-closeout', { method: 'PATCH', body: JSON.stringify({ date: '2026-09-03', action: 'complete', acknowledged_blockers: false, blocker_evidence: 'previously-clear' }) }));
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'CLOSEOUT_BLOCKERS_CHANGED' });
});
