import { NextRequest } from 'next/server';
import { afterEach, expect, it, vi } from 'vitest';
import { KIOSK_DEGRADED_REASON_LABELS as labels } from '@/lib/kiosk-health-labels';

vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: vi.fn(async () => true) }));
vi.mock('@/lib/convex', () => ({ default: { query: vi.fn()
  .mockResolvedValueOnce(['camera', 'recognition'].map(kind => ({
    id: kind, name: kind, type: 'entry', last_sync: new Date().toISOString(),
    health: { camera_ok: kind !== 'camera', model_ok: kind !== 'recognition',
      degraded_reason: kind === 'camera'
        ? 'camera_error,camera_stalled,clock_unsynchronized'
        : 'model_error,recognition_stalled,no_workers_synced' },
  })))
  .mockResolvedValue([]),
} }));

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('shows each specific stall instead of its generic camera/model fault', async () => {
  vi.stubEnv('FACE_SERVICE_KEY', 'synthetic-only');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'ok', model_ready: true, auth_ready: true })));
  const { GET } = await import('./route');
  const response = await GET(new NextRequest('http://synthetic.test/api/system-health?date=2026-10-30'));
  expect(response.status).toBe(200);
  const payload = await response.json();
  expect(payload.kiosks.rows[0].device_issues).toEqual([labels.camera_stalled, labels.clock_unsynchronized]);
  expect(payload.kiosks.rows[1].device_issues).toEqual([labels.recognition_stalled, labels.no_workers_synced]);
});
