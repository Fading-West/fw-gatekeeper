import { NextRequest } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { GET } from './route';
import { authenticateKiosk } from '@/lib/kiosk-device-auth';
import { fetchWorkersForSync, updateKioskLastSync, issueLegacyRosterCursor } from '@/lib/convex-ingest';

vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: () => Promise.resolve(false) }));
vi.mock('@/lib/kiosk-device-auth', () => ({ authenticateKiosk: vi.fn() }));
vi.mock('@/lib/convex-ingest', () => ({ fetchWorkersForSync: vi.fn(), updateKioskLastSync: vi.fn(), issueLegacyRosterCursor: vi.fn() }));
const request = (id: string) => new NextRequest(`http://localhost/api/sync?kiosk_id=${id}`);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(issueLegacyRosterCursor).mockResolvedValue({ issuedAt: '2026-10-09T12:00:00.000Z', since: null });
});

it('keeps unknown, inactive, and mismatched devices from downloading a roster', async () => {
  vi.mocked(authenticateKiosk).mockResolvedValue(null);
  expect((await GET(request('unknown'))).status).toBe(401);
  expect((await GET(request('other'))).status).toBe(401);
  expect(fetchWorkersForSync).not.toHaveBeenCalled();
  expect(updateKioskLastSync).not.toHaveBeenCalled();
  expect(issueLegacyRosterCursor).not.toHaveBeenCalled();
});

it('uses the authenticated document ID for heartbeat and roster access', async () => {
  vi.mocked(authenticateKiosk).mockResolvedValue({ documentId: 'kiosk-document', kioskId: 'entry', aliases: ['entry', 'Front'] });
  vi.mocked(updateKioskLastSync).mockResolvedValue({ updated: true });
  vi.mocked(fetchWorkersForSync).mockResolvedValue({ workers: [] });
  vi.mocked(issueLegacyRosterCursor).mockResolvedValue({ issuedAt: '2026-10-09T12:00:00.000Z', since: null });
  expect((await GET(request('Front'))).status).toBe(200);
  expect(updateKioskLastSync).toHaveBeenCalledWith('kiosk-document', expect.any(String), undefined);
  expect(fetchWorkersForSync).toHaveBeenCalledOnce();
  expect(issueLegacyRosterCursor).toHaveBeenCalledWith('kiosk-document', undefined);
});

it('records health from a credential-authenticated sync on the resolved kiosk', async () => {
  vi.mocked(authenticateKiosk).mockResolvedValue({ documentId: 'kiosk-document', kioskId: 'entry', aliases: ['entry', 'Front'] });
  vi.mocked(updateKioskLastSync).mockResolvedValue({ updated: true });
  vi.mocked(fetchWorkersForSync).mockResolvedValue({ workers: [] });
  const req = new NextRequest('http://localhost/api/sync?kiosk_id=Front&camera_ok=1&model_ok=0&liveness_available=true&known_workers=42&queued_logs=2&queued_attempts=3&degraded_reason=Model%20unavailable&last_scan_at=2026-09-25T12:00:00Z');
  expect((await GET(req)).status).toBe(200);
  expect(updateKioskLastSync).toHaveBeenCalledWith('kiosk-document', expect.any(String), {
    cameraOk: true,
    modelOk: false,
    livenessAvailable: true,
    knownWorkers: 42,
    queuedLogs: 2,
    queuedAttempts: 3,
    degradedReason: 'Model unavailable',
    lastScanAt: '2026-09-25T12:00:00Z',
  });
  expect(issueLegacyRosterCursor).toHaveBeenCalledWith('kiosk-document', undefined);
  expect(fetchWorkersForSync).toHaveBeenCalledWith('');
});
