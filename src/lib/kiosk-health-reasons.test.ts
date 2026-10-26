import { NextRequest } from 'next/server';
import { afterEach, expect, it, vi } from 'vitest';
import { evaluateKioskAlerts, type AlertKiosk } from '../../convex/alerts';
import { getKioskDegradedReasons } from './kiosk-health-reasons';

const query = vi.hoisted(() => vi.fn());
vi.mock('@/lib/convex', () => ({ default: { query } }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: vi.fn(async () => true) }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); query.mockReset(); });

// Wire format from pi-kiosk/sync.py::_health_params (pinned by test_sync_claims.py).
const quarantine = 'upload_quarantine: 1 attendance, 0 recognition';

it('keeps kiosk faults readable when the upload-quarantine clause is appended', () => {
  expect(getKioskDegradedReasons(`no_workers_synced,clock_unsynchronized; ${quarantine}`))
    .toEqual(['no_workers_synced', 'clock_unsynchronized', quarantine]);
  expect(getKioskDegradedReasons(quarantine)).toEqual([quarantine]);
  expect(getKioskDegradedReasons('camera_error, model_error')).toEqual(['camera_error', 'model_error']);
});

it('still raises a device-fault alert for a scan-blocking reason beside quarantined uploads', () => {
  const now = Date.parse('2026-10-26T15:00:00.000Z');
  const reportedAt = new Date(now - 60_000).toISOString();
  const kiosk = (degradedReason: string): AlertKiosk => ({
    kioskId: 'k', name: 'Main Entry', location: 'A', deviceId: 'kiosk-1', lastSync: reportedAt,
    health: { cameraOk: true, modelOk: true, queuedLogs: 0, degradedReason, reportedAt },
  });
  for (const reason of ['liveness_required_unavailable', 'no_workers_synced', 'encoding_mismatch']) {
    expect(evaluateKioskAlerts([kiosk(`${reason}; ${quarantine}`)], now)[0].conditions).toEqual(['device_fault']);
  }
  expect(evaluateKioskAlerts([kiosk(quarantine)], now)[0].conditions).toEqual([]);
});

it('labels every system-health device issue when uploads are quarantined', async () => {
  vi.stubEnv('FACE_SERVICE_KEY', 'synthetic-only');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'ok', model_ready: true, auth_ready: true })));
  query.mockResolvedValueOnce([{
    id: 'synthetic-kiosk', name: 'Synthetic entry', type: 'entry', last_sync: new Date().toISOString(),
    health: { camera_ok: true, model_ok: true, degraded_reason: `no_workers_synced,clock_unsynchronized; ${quarantine}` },
  }]).mockResolvedValue([]);
  const { GET } = await import('@/app/api/system-health/route');
  const payload = await (await GET(new NextRequest('http://synthetic.test/api/system-health?fresh=1'))).json();
  expect(payload.kiosks.rows[0].device_issues).toEqual([
    'no workers synced — every scan is rejected',
    'system clock is not synchronized — attendance times may be wrong; contact a supervisor',
    `degraded (${quarantine})`,
  ]);
});
