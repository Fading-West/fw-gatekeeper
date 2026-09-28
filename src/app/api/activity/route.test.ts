import { NextRequest } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';

import { ActivityBackendError, fetchActivityFeed } from '@/lib/activity-feed';
import { GET } from './route';

vi.mock('@/lib/activity-feed', () => ({
  ActivityBackendError: class ActivityBackendError extends Error {
    constructor(message: string, readonly status = 502) { super(message); }
  },
  fetchActivityFeed: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());

it('forwards the bearer credential and preserves a successful contract response', async () => {
  const payload = { version: 1, asOf: '2026-09-14T18:00:00.000Z', hasMore: false, items: [] };
  vi.mocked(fetchActivityFeed).mockResolvedValue({ body: JSON.stringify(payload), status: 200, contentType: 'application/json' });
  const request = new NextRequest('https://gateway.example.test/api/activity', { headers: { authorization: 'Bearer synthetic-token' } });
  const response = await GET(request);
  expect(fetchActivityFeed).toHaveBeenCalledWith('Bearer synthetic-token');
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual(payload);
});

it('preserves backend authentication and authorization failures as non-2xx responses', async () => {
  vi.mocked(fetchActivityFeed).mockResolvedValue({ body: JSON.stringify({ error: 'Unauthorized' }), status: 401, contentType: 'application/json' });
  expect((await GET(new NextRequest('https://gateway.example.test/api/activity'))).status).toBe(401);
});

it('reports backend failure instead of returning an empty successful feed', async () => {
  vi.mocked(fetchActivityFeed).mockRejectedValue(new ActivityBackendError('Convex activity backend failed.', 502));
  const response = await GET(new NextRequest('https://gateway.example.test/api/activity'));
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: 'Activity feed unavailable' });
});
