import { NextRequest } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';
import convex from '@/lib/convex';
import { POST } from './route';
vi.mock('@/lib/convex', () => ({ default: { mutation: vi.fn() } }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: vi.fn().mockResolvedValue(true) }));
const payload = { date: '2026-09-01', worker_id: 'worker', action: 'add_clock_in', corrected_timestamp: '2026-09-01T08:00:00', reason: 'Missed scan' };
function request(extra: object) {
  return new NextRequest('https://example.test/api/attendance-corrections', { method: 'POST', body: JSON.stringify({ ...payload, ...extra }) });
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(convex.mutation).mockResolvedValue({ id: 'correction', createdAt: '2026-09-01' }); });
it.each(['request_id', 'requestId'])('forwards %s unchanged on every retry', async (field) => {
  const extra = { [field]: 'stable-request' };
  expect((await POST(request(extra))).status).toBe(201);
  expect((await POST(request(extra))).status).toBe(201);
  for (const call of vi.mocked(convex.mutation).mock.calls) expect(call[1]).toMatchObject({ requestId: 'stable-request' });
});
it.each(['', ' ', 123, 'x'.repeat(201)])('rejects invalid request identity %s before mutation', async (request_id) => {
  expect((await POST(request({ request_id }))).status).toBe(400);
  expect(convex.mutation).not.toHaveBeenCalled();
});
it('accepts legacy callers without request identity', async () => {
  expect((await POST(request({}))).status).toBe(201);
});
