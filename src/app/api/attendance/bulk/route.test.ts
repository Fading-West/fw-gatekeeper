import { NextRequest } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { POST } from './route';
import { hasValidKioskKey } from '@/lib/auth';
import { AttendanceBacklogPendingError, ingestAttendanceBacklog } from '@/lib/attendance-backlog';
import { SecuredIngestError } from '@/lib/convex-ingest';
import { authenticateKiosk } from '@/lib/kiosk-device-auth';
vi.mock('@/lib/auth', () => ({ hasValidKioskKey: vi.fn(() => true), unauthorizedApiResponse: () => Response.json({ error: 'Unauthorized' }, { status: 401 }) }));
vi.mock('@/lib/kiosk-device-auth', () => ({ authenticateKiosk: vi.fn(), kioskClaims: (value: Record<string, unknown>) => ['kiosk_id', 'kioskId'].filter(key => Object.hasOwn(value, key)).map(key => value[key]), kioskEvidenceId: (identity: { kioskId: string }, record: Record<string, unknown>, batch?: Record<string, unknown>) => record.kiosk_id ?? record.kioskId ?? batch?.kiosk_id ?? batch?.kioskId ?? identity.kioskId }));
vi.mock('@/lib/attendance-backlog', () => ({ AttendanceBacklogPendingError: class extends Error {}, ingestAttendanceBacklog: vi.fn() }));
beforeEach(() => { vi.clearAllMocks(); vi.mocked(hasValidKioskKey).mockReturnValue(true); vi.mocked(authenticateKiosk).mockResolvedValue({ documentId: 'kiosk-document', kioskId: 'entry', aliases: ['entry'] }); });
const request = (body: unknown) => new NextRequest('http://localhost/api/attendance/bulk', { method: 'POST', body: JSON.stringify(body) });
const log = { worker_id: 'worker', action: 'clock_in', timestamp: '2026-09-01 06:00:00', idempotency_key: 'legacy-key', liveness_confirmed: 1, confidence: 1.0000000000000002 };
it('preserves the old Pi wire format and returns full acknowledgement for 501 logs', async () => {
  vi.mocked(ingestAttendanceBacklog).mockResolvedValue({ synced: 501, acknowledged: 501 });
  const response = await POST(request({ kiosk_id: 'entry', logs: Array(501).fill(log) }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ synced: 501, acknowledged: 501 });
  expect(vi.mocked(ingestAttendanceBacklog).mock.calls[0][0][0]).toMatchObject({ workerId: 'worker', eventType: 'clock_in', kioskId: 'entry', idempotencyKey: 'legacy-key', livenessConfirmed: true, confidence: 1 });
});
it('rejects a malformed final row before forwarding any events', async () => {
  const response = await POST(request({ logs: [...Array(500).fill(log), { ...log, timestamp: 'bad' }] }));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: 'INVALID_ATTENDANCE' });
  expect(ingestAttendanceBacklog).not.toHaveBeenCalled();
});
it('propagates a permanent Convex validation rejection to the kiosk', async () => {
  vi.mocked(ingestAttendanceBacklog).mockRejectedValue(new SecuredIngestError(400, 'INVALID_ATTENDANCE', 'workerId must identify an existing worker'));
  const response = await POST(request({ logs: [log] }));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ code: 'INVALID_ATTENDANCE', error: 'workerId must identify an existing worker' });
});
it('keeps an unrelated upstream 400 retryable', async () => {
  vi.mocked(ingestAttendanceBacklog).mockRejectedValue(new SecuredIngestError(400, undefined, 'Bad Request'));
  expect((await POST(request({ logs: [log] }))).status).toBe(500);
});
it('never returns success for a partially processed backlog', async () => {
  vi.mocked(ingestAttendanceBacklog).mockRejectedValue(new AttendanceBacklogPendingError('Retry pending'));
  expect((await POST(request({ logs: [log] }))).status).toBe(503);
});

it('rejects an unauthorized legacy request before ingest', async () => {
  vi.mocked(authenticateKiosk).mockResolvedValue(null);
  expect((await POST(request({ logs: [log] }))).status).toBe(401);
  expect(ingestAttendanceBacklog).not.toHaveBeenCalled();
});

it('rejects a mismatched final record before forwarding any batch rows', async () => {
  vi.mocked(authenticateKiosk).mockImplementation(async (_req, claims) =>
    claims.includes('other') ? null : { documentId: 'kiosk-document', kioskId: 'entry', aliases: ['entry'] });
  const response = await POST(request({ kiosk_id: 'entry', logs: [...Array(500).fill(log), { ...log, kiosk_id: 'other' }] }));
  expect(response.status).toBe(401);
  expect(ingestAttendanceBacklog).not.toHaveBeenCalled();
});

it('preserves manual clock provenance from the Pi wire format', async () => {
  vi.mocked(ingestAttendanceBacklog).mockResolvedValue({ synced: 1, acknowledged: 1 });
  expect((await POST(request({ logs: [{ ...log, note: 'manual_clock' }] }))).status).toBe(200);
  expect(vi.mocked(ingestAttendanceBacklog).mock.calls[0][0][0]).toMatchObject({ note: 'manual_clock' });
});
it.each([42, {}, 'x'.repeat(501)])('rejects invalid notes before forwarding: %s', async note => {
  expect((await POST(request({ logs: [{ ...log, note }] }))).status).toBe(400);
  expect(ingestAttendanceBacklog).not.toHaveBeenCalled();
});
