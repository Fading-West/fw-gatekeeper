import { NextRequest } from 'next/server';
import { afterEach, expect, it, vi } from 'vitest';
import { POST } from './route';
import { authenticateKiosk } from '@/lib/kiosk-device-auth';
vi.mock('@/lib/kiosk-device-auth', () => ({ authenticateKiosk: vi.fn(() => Promise.resolve({ kioskId: 'entry-1', aliases: ['entry-1'] })), kioskClaims: (value: Record<string, unknown>) => ['kiosk_id', 'kioskId'].filter(key => Object.hasOwn(value, key)).map(key => value[key]) }));
vi.mock('@/lib/auth', () => ({ hasValidKioskKey: () => true, unauthorizedApiResponse: () => Response.json({}, { status: 401 }) }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it('forwards persistent identities and propagates backend conflicts to the kiosk', async () => {
  vi.stubEnv('CONVEX_INGEST_KEY', 'test-key');
  vi.stubEnv('CONVEX_INGEST_URL', 'https://test.convex.site');
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ code: 'RECOGNITION_ATTEMPT_CONFLICT' }, { status: 409 }));
  vi.stubGlobal('fetch', fetchMock);
  const response = await POST(new NextRequest('http://localhost/api/recognition-attempts/bulk', { method: 'POST', body: JSON.stringify({ attempts: [{ sourceAttemptId: 'saved-uuid', legacySourceAttemptId: 'entry-1:1', timestamp: '2026-09-15T08:00:00', kioskId: 'entry-1' }] }) }));
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'RECOGNITION_ATTEMPT_CONFLICT' });
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).attempts[0]).toMatchObject({ sourceAttemptId: 'saved-uuid', legacySourceAttemptId: 'entry-1:1' });
});

it('rejects a mismatched record before any secured ingest call', async () => {
  vi.mocked(authenticateKiosk).mockResolvedValueOnce(null);
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const response = await POST(new NextRequest('http://localhost/api/recognition-attempts/bulk', {
    method: 'POST', body: JSON.stringify({ kiosk_id: 'entry-1', attempts: [{ kioskId: 'other' }] }),
  }));
  expect(response.status).toBe(401);
  expect(fetchMock).not.toHaveBeenCalled();
});
