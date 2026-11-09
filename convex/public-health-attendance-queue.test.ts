/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { afterEach, expect, it, vi } from 'vitest';
import schema from './schema';
const modules = import.meta.glob('./**/*.ts');
afterEach(() => vi.unstubAllEnvs());

it('preserves public pending attendance through omitted counts until an explicit zero', async () => {
  vi.stubEnv('CONVEX_INGEST_KEY', 'synthetic-ingest-key');
  const t = convexTest(schema, modules);
  const kiosk = await t.run(ctx => ctx.db.insert('kiosks', {
    name: 'private kiosk name', type: 'entry', location: 'private location', active: true,
  }));
  let time = Date.now() - 10_000;
  const upload = (queuedLogs?: number, queuedAttempts = 2) => t.fetch('/api/ingest/kiosks/last-sync', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-ingest-key' },
    body: JSON.stringify({ kioskId: kiosk, lastSync: new Date(time += 1000).toISOString(),
      health: { cameraOk: true, modelOk: true, queuedAttempts, queuedLogs } }),
  });
  const read = async () => (await t.fetch('/api/public/kiosk-health', { method: 'GET' })).json();
  expect((await upload()).status).toBe(200);
  expect(await read()).toMatchObject({ kiosks: { queued_records: 2 } });
  expect((await upload(3)).status).toBe(200);
  expect(await read()).toMatchObject({ status: 'degraded', kiosks: { queued_records: 5 } });
  expect((await upload()).status).toBe(200);
  const pending = await read();
  expect(pending).toMatchObject({ status: 'degraded', kiosks: { queued_records: 5 } });
  expect(JSON.stringify(pending)).not.toContain('private');
  expect((await upload(0, 0)).status).toBe(200);
  expect(await read()).toMatchObject({ status: 'healthy', kiosks: { queued_records: 0 } });
});

