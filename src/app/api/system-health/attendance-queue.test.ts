import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/convex', () => ({ default: { query: mocks.query } }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: vi.fn(async () => true) }));

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'ok', model_ready: true, auth_ready: true })));
});
afterEach(() => { vi.unstubAllGlobals(); mocks.query.mockReset(); });

const now = new Date().toISOString();
const kiosk = (name: string, health: object | null, queue: object) => ({ id: name, name, kiosk_id: name, type: 'entry', location: '', last_sync: now,
  roster_applied_at: now, purge_pending: false, health, attendance_queue: queue });

it('reports retained queue observations, not only the latest raw count', async () => {
  mocks.query.mockImplementation(async (_ref: unknown, args: object) => Object.keys(args).length ? [] : [
    kiosk('pending', { camera_ok: true, model_ok: true, queued_logs: 2, reported_at: now }, { status: 'pending', last_valid_count: 2, observed_at: now, caveat: true }),
    kiosk('retained', null, { status: 'unknown', last_valid_count: 6, observed_at: now, caveat: true }),
    kiosk('clear', { camera_ok: true, model_ok: true, queued_logs: 0, reported_at: now }, { status: 'clear', last_valid_count: 0, observed_at: now, caveat: false }),
  ]);
  const { GET } = await import('./route');
  const payload = await (await GET(new NextRequest('http://synthetic.test/api/system-health?fresh=1'))).json();
  const issues = Object.fromEntries(payload.kiosks.rows.map((row: any) => [row.name, row.device_issues]));
  expect(issues.pending).toEqual(['2 attendance records not yet uploaded (incomplete attendance evidence)']);
  expect(issues.retained).toEqual(['Latest report had no valid queue count; last valid report was 6 attendance records not yet uploaded']);
  expect(issues.clear).toEqual([]);
  expect(payload.kiosks.rows.find((row: any) => row.name === 'retained').attendance_queue).toMatchObject({ status: 'unknown', last_valid_count: 6 });
});
