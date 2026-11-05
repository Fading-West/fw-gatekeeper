import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchActivityFeed } from '@/lib/activity-feed';
import { GET } from './route';

vi.mock('@/lib/activity-feed', () => ({
  ActivityBackendError: class extends Error {
    constructor(message: string, readonly status = 502) { super(message); }
  },
  fetchActivityFeed: vi.fn(),
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it.each([
  { status: 200, contentType: 'text/html', body: '<html>PRIVATE_UPSTREAM_DIAGNOSTIC</html>' },
  { status: 503, contentType: 'text/plain', body: 'PRIVATE_UPSTREAM_DIAGNOSTIC' },
  { status: 200, contentType: 'application/json', body: '{"private":"PRIVATE_UPSTREAM_DIAGNOSTIC"' },
  { status: 200, contentType: null, body: '{}' },
  { status: 200, contentType: 'application/jsonish', body: '{}' },
])('rejects unusable upstream JSON ($status, $contentType)', async upstream => {
  vi.mocked(fetchActivityFeed).mockResolvedValue(upstream);
  const response = await GET(new NextRequest('https://gateway.example.test/api/activity'));
  expect(response.status).toBe(502);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(await response.json()).toEqual({ error: 'Activity feed unavailable' });
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('PRIVATE_UPSTREAM_DIAGNOSTIC');
});

it('preserves valid upstream JSON bytes and status', async () => {
  const body = '{ "error": "Forbidden" }';
  vi.mocked(fetchActivityFeed).mockResolvedValue({ body, status: 403, contentType: 'application/json; charset=utf-8' });
  const response = await GET(new NextRequest('https://gateway.example.test/api/activity'));
  expect(response.status).toBe(403);
  expect(await response.text()).toBe(body);
});
