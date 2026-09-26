import { NextRequest } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';
import convex from '@/lib/convex';
import { hasValidPortalSession } from '@/lib/portal-auth';
import { PATCH } from './route';

vi.mock('@/lib/convex', () => ({ default: { mutation: vi.fn() } }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: vi.fn() }));

function request(body: object) {
  return new NextRequest('https://example.test/api/attendance-corrections', { method: 'PATCH', body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hasValidPortalSession).mockResolvedValue(true);
  vi.mocked(convex.mutation).mockResolvedValue({ id: 'reversal-1', createdAt: '2026-09-01' });
});

it('requires operator access before forwarding a reversal', async () => {
  vi.mocked(hasValidPortalSession).mockResolvedValue(false);
  const response = await PATCH(request({ correction_id: 'correction-1', request_id: 'retry-1', reason: 'Wrong scan' }));
  expect(response.status).toBe(401);
  expect(hasValidPortalSession).toHaveBeenCalledWith(expect.anything(), ['admin', 'enrollment']);
  expect(convex.mutation).not.toHaveBeenCalled();
});

it('forwards stable request identity and ignores spoofed actors', async () => {
  const body = { correction_id: 'correction-1', request_id: 'retry-1', reason: 'Wrong scan', actorUserId: 'spoofed' };
  expect((await PATCH(request(body))).status).toBe(200);
  expect((await PATCH(request(body))).status).toBe(200);
  for (const call of vi.mocked(convex.mutation).mock.calls) {
    expect(call[1]).toEqual({ correctionId: 'correction-1', requestId: 'retry-1', reason: 'Wrong scan' });
  }
});

it.each([{ request_id: '' }, { reason: ' ' }, { correction_id: '' }])('rejects incomplete reversals', async (change) => {
  const response = await PATCH(request({ correction_id: 'correction-1', request_id: 'retry-1', reason: 'Wrong scan', ...change }));
  expect(response.status).toBe(400);
  expect(convex.mutation).not.toHaveBeenCalled();
});
