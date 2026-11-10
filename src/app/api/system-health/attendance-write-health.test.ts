import { NextRequest } from 'next/server';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: vi.fn(async () => true) }));
vi.mock('@/lib/convex', () => ({ default: { query: vi.fn()
  .mockResolvedValueOnce([{
    id: 'synthetic-kiosk', name: 'Synthetic entry', type: 'entry',
    last_sync: new Date().toISOString(),
    health: { camera_ok: true, model_ok: true,
      degraded_reason: 'clock_unsynchronized,attendance_write_failed; upload_quarantine: 1 attendance, 0 recognition' },
  }])
  .mockResolvedValue([]),
} }));

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('labels a failed attendance write with supervisor guidance alongside other kiosk reasons', async () => {
  vi.stubEnv('FACE_SERVICE_KEY', 'synthetic-only');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'ok', model_ready: true, auth_ready: true })));
  const { GET } = await import('./route');
  const payload = await (await GET(new NextRequest('http://synthetic.test/api/system-health?date=2026-10-02'))).json();
  expect(payload.kiosks.rows[0].device_issues).toEqual([
    'system clock is not synchronized — attendance times may be wrong; contact a supervisor',
    'attendance write failed — verify the worker’s punch and local storage; retry or ask a supervisor',
    'degraded (upload_quarantine: 1 attendance, 0 recognition)',
  ]);
  expect(payload.warnings).toContain(
    'Kiosk Synthetic entry: attendance write failed — verify the worker’s punch and local storage; retry or ask a supervisor',
  );
});
