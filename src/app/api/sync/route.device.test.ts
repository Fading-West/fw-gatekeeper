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

it('uses the authenticated canonical kiosk ID for heartbeat and roster access', async () => {
  vi.mocked(authenticateKiosk).mockResolvedValue({ kioskId: 'entry', aliases: ['entry', 'Front'] });
  vi.mocked(updateKioskLastSync).mockResolvedValue({ updated: true });
  vi.mocked(fetchWorkersForSync).mockResolvedValue({ workers: [] });
  expect((await GET(request('Front'))).status).toBe(200);
  expect(updateKioskLastSync).toHaveBeenCalledWith('entry', expect.any(String), undefined);
  expect(fetchWorkersForSync).toHaveBeenCalledOnce();
});
