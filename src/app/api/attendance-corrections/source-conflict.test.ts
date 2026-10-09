import { ConvexError } from 'convex/values';
import { NextRequest } from 'next/server';
import { expect, it, vi } from 'vitest';
import convex from '@/lib/convex';
import { POST } from './route';
vi.mock('@/lib/convex', () => ({ default: { mutation: vi.fn() } }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: vi.fn(async () => true) }));
it('returns a recoverable 409 for an obsolete correction source', async () => {
  vi.mocked(convex.mutation).mockRejectedValue(new ConvexError({ code: 'CORRECTION_SOURCE_CONFLICT', message: 'Review the current source' }));
  const response = await POST(new NextRequest('http://localhost/api/attendance-corrections', { method: 'POST', body: JSON.stringify({
    date: '2026-09-03', worker_id: 'synthetic-worker', action: 'add_clock_out', corrected_timestamp: '2026-09-03T18:00:00', reason: 'Verified', related_exception_key: 'stale-source', source_fingerprint: 'reviewed-source',
  }) }));
  expect(convex.mutation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sourceFingerprint: 'reviewed-source' }));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ code: 'CORRECTION_SOURCE_CONFLICT', error: 'Review the current source' });
});
