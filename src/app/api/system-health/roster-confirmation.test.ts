import { NextRequest } from 'next/server';
import { afterEach, expect, it, vi } from 'vitest';
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: vi.fn(async () => true) }));
vi.mock('@/lib/convex', () => ({ default: { query } }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it('adds roster evidence and both issue wordings to rows and dashboard warnings', async () => {
  const now = Date.parse('2026-10-30T12:00:00Z');
  vi.useFakeTimers(); vi.setSystemTime(now);
  const retry = new Date(now - 20 * 60_000).toISOString();
  const rows = [true, false, null].map((waiting, i) => ({
    id: `k-${i}`, name: `Gate ${i}`, last_sync: new Date(now).toISOString(),
    roster_retry_since: retry, roster_changes_waiting: waiting,
  }));
  query.mockResolvedValueOnce([...rows, { ...rows[0], id: 'offline', last_sync: '2020-01-01T00:00:00Z' }]).mockResolvedValue([]);
  vi.stubEnv('FACE_SERVICE_KEY', 'synthetic');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'ok', model_ready: true, auth_ready: true })));
  const { GET } = await import('./route');
  const response = await GET(new NextRequest('http://synthetic.test/api/system-health?fresh=1'));
  const payload = await response.json();
  expect(response.status).toBe(200);
  for (let i = 0; i < 3; i++) {
    expect(payload.kiosks.rows[i]).toMatchObject({ roster_retry_since: retry, roster_changes_waiting: rows[i].roster_changes_waiting, roster_confirmation_stalled: true });
    expect(payload.kiosks.rows[i].device_issues).toContain(i === 0
      ? 'Roster changes awaiting confirmation on this online kiosk'
      : 'Roster confirmation stalled on this online kiosk');
    expect(payload.warnings).toContain(`Kiosk Gate ${i}: ${payload.kiosks.rows[i].device_issues[0]}`);
  }
  expect(payload.kiosks.rows[3].roster_confirmation_stalled).toBe(false);
  expect(payload.kiosks.rows[3].device_issues).toEqual([]);
});
