import { NextRequest } from 'next/server';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: vi.fn(async () => true) }));
vi.mock('@/lib/convex', () => ({ default: { query: vi.fn()
  .mockResolvedValueOnce([{
    id: 'synthetic-kiosk', name: 'Synthetic entry', type: 'entry',
    last_sync: new Date().toISOString(),
    health: { camera_ok: true, model_ok: true, degraded_reason: 'clock_unsynchronized' },
  }, {
    id: 'synthetic-empty-kiosk', name: 'Synthetic empty entry', type: 'entry',
    last_sync: new Date().toISOString(),
    health: { camera_ok: true, model_ok: true, degraded_reason: 'no_workers_synced,clock_unsynchronized' },
  }])
  .mockResolvedValue([]),
} }));

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('exposes clock uncertainty as a readable device issue even for a recently synced kiosk', async () => {
  vi.stubEnv('FACE_SERVICE_KEY', 'synthetic-only');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'ok', model_ready: true, auth_ready: true })));
  const { GET } = await import('./route');
  const response = await GET(new NextRequest('http://synthetic.test/api/system-health?date=2026-10-02'));
  expect(response.status).toBe(200);
  const payload = await response.json();
  expect(payload.kiosks.rows[0].device_issues).toEqual([
    'system clock is not synchronized — attendance times may be wrong; contact a supervisor',
  ]);
  expect(payload.warnings).toContain(
    'Kiosk Synthetic entry: system clock is not synchronized — attendance times may be wrong; contact a supervisor',
  );
  expect(payload.kiosks.rows[1].device_issues).toEqual([
    'no workers synced — every scan is rejected',
    'system clock is not synchronized — attendance times may be wrong; contact a supervisor',
  ]);
});
