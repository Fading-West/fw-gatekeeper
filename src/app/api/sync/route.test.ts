import { NextRequest } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { GET } from './route';
import { POST } from './ack/route';
import { hasDeviceKeyFormat } from '@/lib/auth';
import { authenticateKiosk } from '@/lib/kiosk-device-auth';
import { hasValidPortalSession } from '@/lib/portal-auth';
import { fetchWorkersForSync, issueRosterReceipt, updateKioskLastSync, acknowledgeRosterReceipt } from '@/lib/convex-ingest';

vi.mock('@/lib/auth', () => ({ hasDeviceKeyFormat: vi.fn(() => true), unauthorizedApiResponse: () => Response.json({ error: 'Unauthorized' }, { status: 401 }) }));
vi.mock('@/lib/kiosk-device-auth', () => ({ authenticateKiosk: vi.fn() }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: vi.fn(async () => false) }));
vi.mock('@/lib/convex-ingest', () => ({
  fetchWorkersForSync: vi.fn(), issueRosterReceipt: vi.fn(),
  updateKioskLastSync: vi.fn(), acknowledgeRosterReceipt: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hasDeviceKeyFormat).mockReturnValue(true);
  vi.mocked(hasValidPortalSession).mockResolvedValue(false);
  vi.mocked(authenticateKiosk).mockResolvedValue({ documentId: 'kiosk-document', kioskId: 'entry', aliases: ['entry'] });
  vi.mocked(updateKioskLastSync).mockResolvedValue({ updated: true });
  vi.mocked(fetchWorkersForSync).mockResolvedValue({ workers: [] });
});

it('does not issue an applied-roster receipt for an admin roster read', async () => {
  vi.mocked(hasValidPortalSession).mockResolvedValue(true);
  expect((await GET(request('roster_receipt=1'))).status).toBe(200);
  expect(issueRosterReceipt).not.toHaveBeenCalled();
  expect(authenticateKiosk).not.toHaveBeenCalled();
});

const request = (query: string) => new NextRequest(`http://localhost/api/sync?kiosk_id=entry&${query}`);

it('uses the server-owned cursor for receipts and requires a full initial roster', async () => {
  vi.mocked(issueRosterReceipt).mockResolvedValueOnce({ receipt: 'token-1', issuedAt: '2026-09-25T12:00:00Z', since: null });
  const first = await GET(request('roster_receipt=1&since=2999-01-01T00:00:00Z'));
  expect(await first.json()).toMatchObject({ roster_receipt: 'token-1', full_roster: true });
  expect(issueRosterReceipt).toHaveBeenCalledWith('kiosk-document');
  expect(fetchWorkersForSync).toHaveBeenLastCalledWith('', true);

  vi.mocked(issueRosterReceipt).mockResolvedValueOnce({ receipt: 'token-2', issuedAt: '2026-09-25T12:01:00Z', since: '2026-09-25T12:00:00Z' });
  const next = await GET(request('roster_receipt=1&since=2999-01-01T00:00:00Z'));
  expect(await next.json()).toMatchObject({ roster_receipt: 'token-2', full_roster: false });
  expect(fetchWorkersForSync).toHaveBeenLastCalledWith('2026-09-25T12:00:00Z', true);
});

it('does not return a receipt-bearing roster when a later worker page fails', async () => {
  vi.mocked(issueRosterReceipt).mockResolvedValue({ receipt: 'pending', issuedAt: '2026-09-25T12:00:00Z', since: null });
  vi.mocked(fetchWorkersForSync).mockRejectedValue(new Error('Later page unavailable'));
  const response = await GET(request('roster_receipt=1'));
  expect(response.status).toBe(503);
  expect(await response.json()).not.toHaveProperty('roster_receipt');
  expect(acknowledgeRosterReceipt).not.toHaveBeenCalled();
});

it('keeps the legacy response and caller since parameter compatible without issuing a receipt', async () => {
  vi.mocked(hasDeviceKeyFormat).mockReturnValue(false);
  const response = await GET(request('since=2026-09-01T00:00:00Z'));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ workers: [] });
  expect(issueRosterReceipt).not.toHaveBeenCalled();
  expect(fetchWorkersForSync).toHaveBeenCalledWith('2026-09-01T00:00:00Z');
});

it('requires kiosk authentication and a matching pending acknowledgement', async () => {
  vi.mocked(hasDeviceKeyFormat).mockReturnValue(false);
  const body = { kiosk_id: 'entry', roster_receipt: 'token-1' };
  const req = () => new NextRequest('http://localhost/api/sync/ack', { method: 'POST', body: JSON.stringify(body) });
  expect((await POST(req())).status).toBe(401);
  expect(acknowledgeRosterReceipt).not.toHaveBeenCalled();
  vi.mocked(hasDeviceKeyFormat).mockReturnValue(true);
  vi.mocked(authenticateKiosk).mockResolvedValueOnce(null);
  expect((await POST(req())).status).toBe(401);
  vi.mocked(acknowledgeRosterReceipt).mockResolvedValue({ acknowledged: false, appliedAt: null });
  expect((await POST(req())).status).toBe(409);
  expect(acknowledgeRosterReceipt).toHaveBeenCalledWith('kiosk-document', 'token-1');
});
