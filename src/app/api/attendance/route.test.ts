/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import schema from '../../../../convex/schema';
import { authenticateKiosk } from '@/lib/kiosk-device-auth';
import { POST } from './route';

vi.mock('@/lib/convex', () => ({ default: {} }));
vi.mock('@/lib/kiosk-device-auth', () => ({
  authenticateKiosk: vi.fn(),
  kioskClaims: () => [],
  kioskEvidenceId: (identity: { kioskId: string }) => identity.kioskId,
}));
const modules = import.meta.glob('../../../../convex/**/*.ts');

let t: ReturnType<typeof convexTest>;
let workerId: string;
beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(authenticateKiosk).mockResolvedValue({ documentId: 'kiosk-document', kioskId: 'entry', aliases: ['entry'] } as any);
  vi.stubEnv('CONVEX_INGEST_URL', 'https://ingest.example.test');
  vi.stubEnv('CONVEX_INGEST_KEY', 'single-ingest-key');
  t = convexTest(schema, modules);
  workerId = await t.run(ctx => ctx.db.insert('workers', { name: 'Worker', department: 'Assembly', active: true, enrolledAt: '2026-09-01' }));
  // Route the secured ingest request into the real Convex HTTP action.
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) =>
    t.fetch(new URL(url).pathname, { method: init.method, headers: init.headers, body: init.body })));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const post = (body: unknown) => POST(new NextRequest('http://localhost/api/attendance', { method: 'POST', body: JSON.stringify(body) }));
const event = (fields: Record<string, unknown> = {}) => ({
  worker_id: workerId, event_type: 'clock_in', timestamp: '2026-09-01T06:00:00', idempotency_key: 'scan-1', ...fields,
});

it('records a valid event', async () => {
  const response = await post(event());
  expect(response.status).toBe(201);
  expect(await t.run(ctx => ctx.db.query('attendance').collect())).toHaveLength(1);
});

it('reports a permanent rejection for an unknown worker instead of a retryable 500', async () => {
  const removed = await t.run(async ctx => {
    const id = await ctx.db.insert('workers', { name: 'Removed', department: '', active: false, enrolledAt: '2026-09-01' });
    await ctx.db.delete(id);
    return id;
  });
  const response = await post(event({ worker_id: removed }));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ code: 'INVALID_ATTENDANCE', error: 'workerId must identify an existing worker' });
});

it('reports a reused idempotency key with different evidence as a permanent rejection', async () => {
  expect((await post(event())).status).toBe(201);
  const response = await post(event({ timestamp: '2026-09-01T06:05:00' }));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ code: 'INVALID_ATTENDANCE', error: 'An idempotency key cannot be reused for different attendance evidence' });
  expect(await t.run(ctx => ctx.db.query('attendance').collect())).toHaveLength(1);
});
