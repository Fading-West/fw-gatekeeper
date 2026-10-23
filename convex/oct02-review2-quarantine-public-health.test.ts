/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { afterEach, expect, it, vi } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
const modules = import.meta.glob('./**/*.ts');
afterEach(() => vi.unstubAllEnvs());
it('carries rejected counts through secured health ingest without presenting them as retryable or disclosing source evidence', async () => {
  vi.stubEnv('CONVEX_INGEST_KEY', 'synthetic-ingest-key');
  const t = convexTest(schema, modules);
  const { kiosk, uid } = await t.run(async ctx => {
    const kiosk = await ctx.db.insert('kiosks', { name: 'Synthetic entry', kioskId: 'synthetic', type: 'entry', location: 'Synthetic location', active: true });
    const uid = await ctx.db.insert('users', { email: 'synthetic-admin@example.test' });
    await ctx.db.insert('portalMembers', { userId: uid, role: 'admin', active: true, createdAt: new Date().toISOString() });
    return { kiosk, uid };
  });
  const upload = (authorized: boolean, rejectedAttempts: number) => t.fetch('/api/ingest/kiosks/last-sync', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? { authorization: 'Bearer synthetic-ingest-key' } : {}) },
    body: JSON.stringify({ kioskId: kiosk, lastSync: new Date().toISOString(), health: { cameraOk: true, modelOk: true, queuedLogs: 0, queuedAttempts: 0, rejectedAttempts } }),
  });
  expect((await upload(false, 4)).status).toBe(401);
  expect((await t.run(ctx => ctx.db.get(kiosk)))!.health).toBeUndefined();
  expect((await upload(true, 4)).status).toBe(200);
  const manager = await t.withIdentity({ subject: uid }).query(api.kiosks.list, {});
  expect(manager[0].health).toMatchObject({ queued_attempts: 0, rejected_attempts: 4 });
  const publicResponse = await t.fetch('/api/public/kiosk-health', { method: 'GET' });
  const publicBody = await publicResponse.json();
  expect(publicBody).toMatchObject({ status: 'degraded', kiosks: { queued_records: 0, rejected_recognition_records: 4 } });
  const serialized = JSON.stringify(publicBody);
  expect(serialized).not.toContain('Synthetic entry');
  expect(serialized).not.toContain('Synthetic location');
  expect(serialized).not.toContain('sourceAttemptId');
  expect((await upload(true, 0)).status).toBe(200);
  expect(await (await t.fetch('/api/public/kiosk-health', { method: 'GET' })).json()).toMatchObject({ status: 'healthy', kiosks: { queued_records: 0, rejected_recognition_records: 0 } });
});
