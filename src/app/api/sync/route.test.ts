import { NextRequest } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { GET } from './route';
import { POST } from './ack/route';
import { hasValidKioskKey } from '@/lib/auth';
import { fetchWorkersForSync, issueRosterReceipt, updateKioskLastSync, acknowledgeRosterReceipt } from '@/lib/convex-ingest';

vi.mock('@/lib/auth', () => ({ hasValidKioskKey: vi.fn(() => true), unauthorizedApiResponse: () => Response.json({ error: 'Unauthorized' }, { status: 401 }) }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: vi.fn(async () => false) }));
vi.mock('@/lib/convex-ingest', () => ({
  fetchWorkersForSync: vi.fn(), issueRosterReceipt: vi.fn(),
  updateKioskLastSync: vi.fn(), acknowledgeRosterReceipt: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hasValidKioskKey).mockReturnValue(true);
  vi.mocked(updateKioskLastSync).mockResolvedValue({ updated: true });
  vi.mocked(fetchWorkersForSync).mockResolvedValue({ workers: [] });
});

const request = (query: string) => new NextRequest(`http://localhost/api/sync?kiosk_id=entry&${query}`);

it('uses the server-owned cursor for receipts and requires a full initial roster', async () => {
  vi.mocked(issueRosterReceipt).mockResolvedValueOnce({ receipt: 'token-1', issuedAt: '2026-09-25T12:00:00Z', since: null });
  const first = await GET(request('roster_receipt=1&since=2999-01-01T00:00:00Z'));
  expect(await first.json()).toMatchObject({ roster_receipt: 'token-1', full_roster: true });
  expect(fetchWorkersForSync).toHaveBeenLastCalledWith('', true);

  vi.mocked(issueRosterReceipt).mockResolvedValueOnce({ receipt: 'token-2', issuedAt: '2026-09-25T12:01:00Z', since: '2026-09-25T12:00:00Z' });
  const next = await GET(request('roster_receipt=1&since=2999-01-01T00:00:00Z'));
  expect(await next.json()).toMatchObject({ roster_receipt: 'token-2', full_roster: false });
  expect(fetchWorkersForSync).toHaveBeenLastCalledWith('2026-09-25T12:00:00Z', true);
});

it('keeps the legacy response and caller since parameter compatible without issuing a receipt', async () => {
  const response = await GET(request('since=2026-09-01T00:00:00Z'));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ workers: [] });
  expect(issueRosterReceipt).not.toHaveBeenCalled();
  expect(fetchWorkersForSync).toHaveBeenCalledWith('2026-09-01T00:00:00Z');
});

it('requires kiosk authentication and a matching pending acknowledgement', async () => {
  vi.mocked(hasValidKioskKey).mockReturnValue(false);
  const body = { kiosk_id: 'entry', roster_receipt: 'token-1' };
  const req = () => new NextRequest('http://localhost/api/sync/ack', { method: 'POST', body: JSON.stringify(body) });
  expect((await POST(req())).status).toBe(401);
  expect(acknowledgeRosterReceipt).not.toHaveBeenCalled();
  vi.mocked(hasValidKioskKey).mockReturnValue(true);
  vi.mocked(acknowledgeRosterReceipt).mockResolvedValue({ acknowledged: false, appliedAt: null });
  expect((await POST(req())).status).toBe(409);
});
