import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/convex', () => ({ default: { query } }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: vi.fn(async () => true) }));

beforeEach(() => { vi.resetModules(); query.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it.each(['UTC', 'Asia/Tokyo', 'Europe/Paris'])('returns the latest punch instant for a %s server', async timezone => {
  vi.stubEnv('TZ', timezone);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'ok', model_ready: true, auth_ready: true })));
  query.mockResolvedValueOnce([{ id: 'entry', name: 'Entry', last_sync: null }])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([
      // Wall-clock order runs backwards, but the second occurrence is later.
      { kiosk_id: 'entry', timestamp: '2026-11-01T01:15:00', timestamp_utc: '2026-11-01T07:15:00Z' },
      { kiosk_id: 'entry', timestamp: '2026-11-01T01:45:00', timestamp_utc: '2026-11-01T06:45:00Z' },
      { kiosk_id: 'entry', timestamp: '2026-11-01T01:30:00' },
      { kiosk_id: 'entry', timestamp: '2026-11-01T08:00:00+02:00' },
      { kiosk_id: 'entry', timestamp: 'invalid' },
    ]);
  const { GET } = await import('./route');
  const response = await GET(new NextRequest('https://example.test/api/system-health?date=2026-11-01'));
  expect(response.status).toBe(200);
  const payload = await response.json();
  expect(payload.kiosks.rows[0].last_attendance_upload).toBe('2026-11-01T07:15:00.000Z');
  expect(payload.sync.last_attendance_upload).toBe('2026-11-01T07:15:00.000Z');
});
