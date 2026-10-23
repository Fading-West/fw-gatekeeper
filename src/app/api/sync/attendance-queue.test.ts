import { NextRequest } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { GET } from './route';
import { authenticateKiosk } from '@/lib/kiosk-device-auth';
import { fetchWorkersForSync, updateKioskLastSync } from '@/lib/convex-ingest';

vi.mock('@/lib/kiosk-device-auth', () => ({ authenticateKiosk: vi.fn() }));
vi.mock('@/lib/convex-ingest', () => ({ fetchWorkersForSync: vi.fn(), updateKioskLastSync: vi.fn(), issueRosterReceipt: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authenticateKiosk).mockResolvedValue({ documentId: 'kiosk-document', kioskId: 'entry', aliases: ['entry'] });
  vi.mocked(updateKioskLastSync).mockResolvedValue({ updated: true });
  vi.mocked(fetchWorkersForSync).mockResolvedValue({ workers: [] });
});
const sync = (query: string) => GET(new NextRequest(`http://localhost/api/sync?kiosk_id=entry&camera_ok=1&${query}`));

it.each(['', ' ', '1.5', '-1', '01', '1e3', '0x10', 'true', 'null', ' 5', '5 ', '9007199254740992'])('keeps queued_logs=%j unknown instead of zero', async value => {
  expect((await sync(`queued_logs=${encodeURIComponent(value)}&queued_attempts=${encodeURIComponent(value)}`)).status).toBe(200);
  const health = vi.mocked(updateKioskLastSync).mock.calls[0][2];
  expect(health).toMatchObject({ cameraOk: true });
  expect(health?.queuedLogs).toBeUndefined();
  expect(health?.queuedAttempts).toBeUndefined();
});

it.each([['0', 0], ['1', 1], ['237', 237]])('accepts canonical queued_logs=%s', async (value, expected) => {
  await sync(`queued_logs=${value}&queued_attempts=4`);
  expect(vi.mocked(updateKioskLastSync).mock.calls[0][2]).toMatchObject({ queuedLogs: expected, queuedAttempts: 4 });
});

it('sends no health when the only field is a blank queue count', async () => {
  await GET(new NextRequest('http://localhost/api/sync?kiosk_id=entry&queued_logs='));
  expect(updateKioskLastSync).toHaveBeenCalledWith('kiosk-document', expect.any(String), undefined);
});
