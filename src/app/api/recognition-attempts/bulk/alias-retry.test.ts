/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import schema from '../../../../../convex/schema';
import { POST } from './route';

vi.mock('@/lib/kiosk-device-auth', async original => ({
  ...await original<typeof import('@/lib/kiosk-device-auth')>(),
  authenticateKiosk: async () => ({ documentId: 'synthetic-kiosk', kioskId: 'entry', aliases: ['entry'] }),
}));

const modules = import.meta.glob('../../../../../convex/**/*.ts');
let t: ReturnType<typeof convexTest>;
beforeEach(() => {
  vi.stubEnv('CONVEX_INGEST_URL', 'https://synthetic.convex.site');
  vi.stubEnv('CONVEX_INGEST_KEY', 'synthetic-ingest-key');
  t = convexTest(schema, modules);
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) =>
    t.fetch(new URL(url).pathname, { method: init.method, headers: init.headers, body: init.body })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const post = (fields: Record<string, unknown>) => POST(new NextRequest('http://localhost/api/recognition-attempts/bulk', {
  method: 'POST', body: JSON.stringify({ attempts: [{
    sourceAttemptId: 'synthetic-scan', timestamp: '2026-11-12T08:00:00',
    decision: 'unknown', ...fields,
  }] }),
}));

it.each(['candidateWorkerName', 'worker_name', 'workerName'])('retries candidate_worker_name as %s without changing captured evidence', async alias => {
  expect((await post({ candidate_worker_name: 'Synthetic Worker' })).status).toBe(201);
  const retry = await post({ [alias]: 'Synthetic Worker' });
  expect(retry.status).toBe(201);
  expect(await retry.json()).toMatchObject({ ingested: 0, skipped: 1 });
  const rows = await t.run(ctx => ctx.db.query('recognitionAttempts').collect());
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ faceDetected: true, candidateWorkerName: 'Synthetic Worker' });
});

it.each([false, 0, 'false'])('preserves an explicit false face-detection report (%s) with a candidate name', async faceDetected => {
  expect((await post({ candidateWorkerName: 'Synthetic Worker', faceDetected })).status).toBe(201);
  const rows = await t.run(ctx => ctx.db.query('recognitionAttempts').collect());
  expect(rows[0]).toMatchObject({ faceDetected: false });
});

it('does not infer a face from a blank candidate name', async () => {
  expect((await post({ candidateWorkerName: '  ' })).status).toBe(201);
  const rows = await t.run(ctx => ctx.db.query('recognitionAttempts').collect());
  expect(rows[0]).toMatchObject({ faceDetected: false });
});

it('still rejects a retry that changes explicit face-detection evidence', async () => {
  expect((await post({ candidate_worker_name: 'Synthetic Worker', face_detected: false })).status).toBe(201);
  const retry = await post({ candidateWorkerName: 'Synthetic Worker', faceDetected: true });
  expect(retry.status).toBe(409);
  expect(await retry.json()).toMatchObject({ code: 'RECOGNITION_ATTEMPT_CONFLICT' });
  const rows = await t.run(ctx => ctx.db.query('recognitionAttempts').collect());
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ faceDetected: false });
});
