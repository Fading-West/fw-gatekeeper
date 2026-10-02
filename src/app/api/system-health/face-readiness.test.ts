import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/lib/convex', () => ({ default: { query: vi.fn(async () => []) } }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: vi.fn(async () => true) }));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('FACE_SERVICE_KEY', 'synthetic-only');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function health(body: object, status = 200) {
  const fetchMock = vi.fn(async () => Response.json(body, { status }));
  vi.stubGlobal('fetch', fetchMock);
  const { GET } = await import('./route');
  const response = await GET(new NextRequest('http://synthetic.test/api/system-health?date=2026-10-02'));
  expect(response.status).toBe(200);
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls[0][1]).not.toHaveProperty('headers');
  return response.json();
}

it('keeps legacy model-file existence degraded until usable readiness is explicit', async () => {
  const payload = await health({ status: 'ok', rec_exists: true });
  expect(payload.face_service).toMatchObject({ status: 'degraded', model_ready: false });
  expect(payload.warnings).toContain('Face service models are not ready. Face enrollment may fail.');
});

it('reports initialized and authenticated enrollment service online', async () => {
  const payload = await health({ status: 'ok', rec_exists: true, model_ready: true, auth_ready: true });
  expect(payload.face_service).toMatchObject({ status: 'online', model_ready: true });
});

it.each([
  { status: 'degraded', model_ready: false, auth_ready: true },
  { status: 'ok', model_ready: true, auth_ready: false },
  { status: 'ok', model_ready: 'true', auth_ready: true },
])('rejects unavailable or malformed readiness fields %j', async (body) => {
  expect((await health(body)).face_service.status).toBe('degraded');
});

it('does not report enrollment ready when the portal authentication is absent', async () => {
  vi.stubEnv('FACE_SERVICE_KEY', '');
  expect((await health({ status: 'ok', model_ready: true, auth_ready: true })).face_service.status).toBe('degraded');
});
