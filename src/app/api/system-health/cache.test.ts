import { getFunctionName } from 'convex/server';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import convex from '@/lib/convex';
import { hasValidPortalSession } from '@/lib/portal-auth';
import { systemHealthCache } from '@/lib/system-health-cache';
import { GET } from './route';
import { POST as register } from '../kiosks/route';
import { POST as issue, DELETE as revoke } from '../kiosks/credentials/route';
import { POST as purge } from '../workers/purge-biometrics/route';
import { PATCH as updateWorker, DELETE as removeWorker } from '../workers/route';

vi.mock('@/lib/convex', () => ({ default: { query: vi.fn(), mutation: vi.fn() } }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: vi.fn() }));

let role: 'admin' | 'enrollment' | 'viewer' | null;
let rows: Array<Record<string, unknown>>;
const request = (path: string, method = 'GET', body?: object) => new NextRequest(`https://synthetic.test/api/${path}`, {
  method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
});
const health = (date = '2026-10-09', fresh = false) => GET(request(`system-health?date=${date}${fresh ? '&fresh=1' : ''}`));

beforeEach(() => {
  vi.resetAllMocks();
  systemHealthCache.invalidate();
  role = 'admin';
  rows = [];
  vi.mocked(hasValidPortalSession).mockImplementation(async (_req, roles = []) => role !== null && roles.includes(role));
  vi.mocked(convex.query).mockImplementation(async (...call) => getFunctionName(call[0]) === 'kiosks:list' ? structuredClone(rows) : []);
  vi.mocked(convex.mutation).mockResolvedValue({ id: 'entry-2', kioskId: 'entry-2' });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'ok', model_ready: true, auth_ready: true })));
});
afterEach(() => vi.unstubAllGlobals());

it('shows a registered kiosk immediately when refreshing a warm dashboard cache', async () => {
  expect((await (await health()).json()).kiosks.rows).toEqual([]);
  await health('2026-10-08');
  vi.mocked(convex.mutation).mockImplementationOnce(async () => {
    rows.push({ id: 'entry-2', name: 'Entry-2', type: 'entry' });
    return { id: 'entry-2' };
  });
  const response = await register(request('kiosks', 'POST', { name: 'Entry-2', type: 'entry' }));
  expect(response.status).toBe(201);
  for (const date of ['2026-10-09', '2026-10-08']) {
    expect((await (await health(date)).json()).kiosks.rows).toMatchObject([{ name: 'Entry-2' }]);
  }
});

it('bypasses a warm cache for admins even if another portal instance handled the mutation', async () => {
  await health();
  rows.push({ id: 'entry-2', name: 'Entry-2', type: 'entry' });
  expect((await (await health()).json()).kiosks.rows).toEqual([]);
  expect((await (await health('2026-10-09', true)).json()).kiosks.rows).toMatchObject([{ name: 'Entry-2' }]);
  expect((await (await health()).json()).kiosks.rows).toMatchObject([{ name: 'Entry-2' }]);
});

it.each(['enrollment', 'viewer', null] as const)('denies bypass to %s before any health queries, including cache hits', async (caller) => {
  await health();
  vi.mocked(convex.query).mockClear();
  role = caller;
  expect((await health('2026-10-09', true)).status).toBe(401);
  expect(convex.query).not.toHaveBeenCalled();
  expect((await health()).status).toBe(caller === null ? 401 : 200);
  expect(convex.query).not.toHaveBeenCalled();
});

it.each([
  ['issue credential', () => issue(request('kiosks/credentials', 'POST', { id: 'entry-2' }))],
  ['revoke credential', () => revoke(request('kiosks/credentials', 'DELETE', { id: 'entry-2', confirmStopSync: true }))],
  ['purge worker', () => purge(request('workers/purge-biometrics', 'POST', { id: 'worker-1', reason: 'Requested' }))],
  ['update worker', () => updateWorker(request('workers', 'PATCH', { id: 'worker-1', name: 'Changed' }))],
  ['remove worker', () => removeWorker(request('workers?id=worker-1', 'DELETE'))],
] as const)('invalidates all dates after successful %s', async (_label, mutate) => {
  rows.push({ id: 'entry-2', name: 'Entry-2', type: 'entry', purge_pending: false });
  await health();
  await health('2026-10-08');
  vi.mocked(convex.mutation).mockImplementationOnce(async () => {
    rows[0].purge_pending = true;
    return { kioskId: 'entry-2' };
  });
  expect((await mutate()).status).toBe(200);
  for (const date of ['2026-10-09', '2026-10-08']) {
    const payload = await (await health(date)).json();
    expect(payload.kiosks.rows[0].purge_pending).toBe(true);
    expect(payload.warnings).toContain('Kiosk Entry-2: Biometric purge still unconfirmed on this kiosk');
  }
});

it('keeps cached data after a failed mutation', async () => {
  await health();
  vi.mocked(convex.query).mockClear();
  vi.mocked(convex.mutation).mockRejectedValueOnce(new Error('synthetic failure'));
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect((await register(request('kiosks', 'POST', { name: 'Entry-2', type: 'entry' }))).status).toBe(500);
    expect((await health()).status).toBe(200);
    expect(convex.query).not.toHaveBeenCalled();
  } finally { log.mockRestore(); }
});
