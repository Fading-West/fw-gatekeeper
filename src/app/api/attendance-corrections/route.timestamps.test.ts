import { ConvexError } from 'convex/values';
import { NextRequest } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';
import convex from '@/lib/convex';
import { POST } from './route';

vi.mock('@/lib/convex', () => ({ default: { mutation: vi.fn() } }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: vi.fn().mockResolvedValue(true) }));
vi.mock('@/lib/auth', () => ({ unauthorizedApiResponse: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

it('returns HTTP 400 for backend correction timestamp validation errors', async () => {
  const message = 'correctedTimestamp must be a valid ISO date and time, with optional UTC offset.';
  vi.mocked(convex.mutation).mockRejectedValue(new ConvexError({ code: 'INVALID_CORRECTION_TIMESTAMP', message }));
  const response = await POST(new NextRequest('https://gateway.example.test/api/attendance-corrections', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ date: '2026-09-01', worker_id: 'worker', action: 'add_clock_in', reason: 'Missed scan', corrected_timestamp: '2026-09-01T99:99:99' }),
  }));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: message });
});
