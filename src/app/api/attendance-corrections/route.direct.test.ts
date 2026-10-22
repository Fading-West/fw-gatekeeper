import { NextRequest } from 'next/server';
import { ConvexError } from 'convex/values';
import { beforeEach, expect, it, vi } from 'vitest';
import convex from '@/lib/convex';
import { hasValidPortalSession } from '@/lib/portal-auth';
import { POST } from './route';

// Direct corrections come from the Activity Log with no related exception.
vi.mock('@/lib/convex', () => ({ default: { mutation: vi.fn() } }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: vi.fn() }));

const directVoid = { date: '2026-09-14', worker_id: 'worker-1', action: 'void_event', original_attendance_id: 'raw-1', reason: 'Wrong person', request_id: 'direct-void-1' };
const directAdd = { date: '2026-09-14', worker_id: 'worker-1', action: 'add_clock_out', corrected_timestamp: '2026-09-14T17:05:00', reason: 'Forgot to clock out', request_id: 'direct-add-1' };

function request(body: object) {
  return new NextRequest('https://example.test/api/attendance-corrections', { method: 'POST', body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hasValidPortalSession).mockResolvedValue(true);
  vi.mocked(convex.mutation).mockResolvedValue({ id: 'correction-1', createdAt: '2026-09-14T18:00:00Z' });
});

it.each([
  ['void', directVoid, { action: 'void_event', originalAttendanceId: 'raw-1', correctedTimestamp: undefined }],
  ['add', directAdd, { action: 'add_clock_out', correctedTimestamp: '2026-09-14T17:05:00', originalAttendanceId: undefined }],
])('forwards a direct %s with no related exception key', async (_label, body, expected) => {
  const response = await POST(request(body));
  expect(response.status).toBe(201);
  const args = vi.mocked(convex.mutation).mock.calls[0][1];
  expect(args).toMatchObject({ date: '2026-09-14', workerId: 'worker-1', requestId: body.request_id, ...expected });
  expect(args?.relatedExceptionKey).toBeUndefined();
});

it('rejects viewer writes before reaching Convex', async () => {
  vi.mocked(hasValidPortalSession).mockResolvedValue(false);
  const response = await POST(request(directVoid));
  expect(response.status).toBe(401);
  expect(hasValidPortalSession).toHaveBeenCalledWith(expect.anything(), ['admin', 'enrollment']);
  expect(convex.mutation).not.toHaveBeenCalled();
});

it('rejects an empty reason server-side', async () => {
  const response = await POST(request({ ...directVoid, reason: '   ' }));
  expect(response.status).toBe(400);
  expect(convex.mutation).not.toHaveBeenCalled();
});

// Production Convex keeps ConvexError data but redacts plain Error messages,
// so these are the payloads the route sees in production (#205).
it('maps a second active void to a readable 409', async () => {
  const message = 'This attendance event already has an active void; reverse that correction before voiding it again';
  vi.mocked(convex.mutation).mockRejectedValue(new ConvexError(message));
  const response = await POST(request(directVoid));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: message });
});

it('maps a time off the correction date to a readable 400', async () => {
  vi.mocked(convex.mutation).mockRejectedValue(new ConvexError({ code: 'INVALID_CORRECTION_TIMESTAMP', message: 'correctedTimestamp must be on the correction date.' }));
  const response = await POST(request({ ...directAdd, corrected_timestamp: '2026-09-15T01:00:00' }));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'correctedTimestamp must be on the correction date.' });
});

it('keeps a redacted production server error generic', async () => {
  vi.mocked(convex.mutation).mockRejectedValue(new Error('[Request ID: 0123456789abcdef] Server Error'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const response = await POST(request(directVoid));
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: 'Failed to create attendance correction' });
});
