import { ConvexError } from 'convex/values';
import { NextRequest } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';
import convex from '@/lib/convex';
import { PATCH } from './route';
vi.mock('@/lib/convex', () => ({ default: { mutation: vi.fn() } }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: vi.fn(async () => true) }));
beforeEach(() => vi.clearAllMocks());
const request = (date = '2026-09-03') => new NextRequest('http://localhost/api/shift-exceptions', { method: 'PATCH', body: JSON.stringify({ date, exception_key: 'synthetic-source', type: 'scan_sequence', source_fingerprint: 'reviewed-source', status: 'reviewed' }) });
it('returns a recoverable conflict for obsolete evidence', async () => {
  vi.mocked(convex.mutation).mockRejectedValue(new ConvexError({ code: 'EXCEPTION_SOURCE_CONFLICT', message: 'Refresh source' }));
  const response = await PATCH(request());
  expect(convex.mutation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sourceFingerprint: 'reviewed-source' }));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ code: 'EXCEPTION_SOURCE_CONFLICT', error: 'Refresh source' });
});
it('rejects a syntactically formatted impossible date before the mutation', async () => {
  expect((await PATCH(request('2026-02-30'))).status).toBe(400);
  expect(convex.mutation).not.toHaveBeenCalled();
});
