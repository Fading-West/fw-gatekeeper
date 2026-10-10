import { NextRequest } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { GET } from './route';
import { authenticateKiosk } from '@/lib/kiosk-device-auth';
import { fetchWorkersForSync, updateKioskLastSync } from '@/lib/convex-ingest';

vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: () => Promise.resolve(false) }));
vi.mock('@/lib/kiosk-device-auth', () => ({ authenticateKiosk: vi.fn() }));
vi.mock('@/lib/convex-ingest', () => ({ fetchWorkersForSync: vi.fn(), updateKioskLastSync: vi.fn() }));
const request = (id: string) => new NextRequest(`http://localhost/api/sync?kiosk_id=${id}`);
beforeEach(() => vi.clearAllMocks());

it('keeps unknown, inactive, and mismatched devices from downloading a roster', async () => {
  vi.mocked(authenticateKiosk).mockResolvedValue(null);
  expect((await GET(request('unknown'))).status).toBe(401);
  expect((await GET(request('other'))).status).toBe(401);
  expect(fetchWorkersForSync).not.toHaveBeenCalled();
  expect(updateKioskLastSync).not.toHaveBeenCalled();
});

it('uses the authenticated document ID for heartbeat and roster access', async () => {
  vi.mocked(authenticateKiosk).mockResolvedValue({ documentId: 'kiosk-document', kioskId: 'entry', aliases: ['entry', 'Front'] });
  vi.mocked(updateKioskLastSync).mockResolvedValue({ updated: true });
  vi.mocked(fetchWorkersForSync).mockResolvedValue({ workers: [] });
  expect((await GET(request('Front'))).status).toBe(200);
  expect(updateKioskLastSync).toHaveBeenCalledWith('kiosk-document', expect.any(String), undefined);
  expect(fetchWorkersForSync).toHaveBeenCalledOnce();
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
  expect(fetchWorkersForSync).toHaveBeenCalledWith('1970-01-01T00:00:00.000Z');
});
