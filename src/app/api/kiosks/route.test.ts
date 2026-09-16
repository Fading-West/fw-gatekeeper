import { ConvexError } from 'convex/values';
import { NextRequest } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';
import convex from '@/lib/convex';
import { POST } from './route';
vi.mock('@/lib/convex', () => ({ default: { mutation: vi.fn() } }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: vi.fn().mockResolvedValue(true) }));
beforeEach(() => vi.clearAllMocks());
it.each([
  ['KIOSK_IDENTIFIER_CONFLICT', 409, 'Kiosk name or sync ID is already used by another active kiosk.'],
  ['INVALID_KIOSK_NAME', 400, 'Kiosk name required'],
  ['KIOSK_FLEET_LIMIT', 400, 'Kiosk registration supports up to 1,000 active kiosks.'],
])('returns actionable registration errors for %s', async (code, status, message) => {
  vi.mocked(convex.mutation).mockRejectedValue(new ConvexError({ code, message }));
  const response = await POST(new NextRequest('https://gateway.example.test/api/kiosks', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Gate', kiosk_id: 'gate', type: 'entry' }),
  }));
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error: message });
});
