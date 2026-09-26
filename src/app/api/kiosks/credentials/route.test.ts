import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';
import convex from '@/lib/convex';
import { hasValidPortalSession } from '@/lib/portal-auth';
import { DELETE, POST } from './route';

vi.mock('@/lib/convex', () => ({ default: { mutation: vi.fn() } }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: vi.fn() }));
beforeEach(() => { vi.clearAllMocks(); vi.mocked(hasValidPortalSession).mockResolvedValue(true); });
const request = (method: 'POST' | 'DELETE', body: Record<string, unknown> = { id: 'kiosk-id' }) => new NextRequest('http://localhost/api/kiosks/credentials', {
  method, body: JSON.stringify(body),
});

it('requires an explicit stop-sync confirmation before the revoke mutation', async () => {
  const rejected = await DELETE(request('DELETE'));
  expect(rejected.status).toBe(400);
  expect(await rejected.json()).toMatchObject({ error: expect.stringContaining('stop syncing') });
  expect(convex.mutation).not.toHaveBeenCalled();
  vi.mocked(convex.mutation).mockResolvedValue({ ok: true });
  const accepted = await DELETE(request('DELETE', { id: 'kiosk-id', confirmStopSync: true }));
  expect(accepted.status).toBe(200);
  expect(vi.mocked(convex.mutation).mock.calls[0][1]).toEqual({ id: 'kiosk-id', confirmStopSync: true });
});

it('issues a one-time random secret while sending only its hash to Convex', async () => {
  vi.mocked(convex.mutation).mockResolvedValue({ kioskId: 'entry' });
  const response = await POST(request('POST'));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ kiosk_id: 'entry', credential: expect.stringMatching(/^gkdev_[A-Za-z0-9_-]{43}$/) });
  expect(vi.mocked(convex.mutation).mock.calls[0][1]).toEqual({ id: 'kiosk-id', credentialHash: createHash('sha256').update(body.credential).digest('hex') });
});

it('requires admin before issuing or revoking', async () => {
  vi.mocked(hasValidPortalSession).mockResolvedValue(false);
  expect((await POST(request('POST'))).status).toBe(401);
  expect((await DELETE(request('DELETE'))).status).toBe(401);
  expect(convex.mutation).not.toHaveBeenCalled();
});
