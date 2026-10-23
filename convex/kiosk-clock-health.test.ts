/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.ts');
afterEach(() => vi.unstubAllEnvs());

it('persists combined clock and roster faults through the authenticated HTTP heartbeat', async () => {
  vi.stubEnv('CONVEX_INGEST_KEY', 'synthetic-only-ingest-key');
  const t = convexTest(schema, modules);
  const now = new Date().toISOString();
  const userId = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'reviewer@example.test' });
    await ctx.db.insert('portalMembers', { userId, role: 'admin', active: true, createdAt: now });
    await ctx.db.insert('kiosks', { name: 'Entry', kioskId: 'clock-entry', type: 'entry', location: '', active: true });
    return userId;
  });
  const reason = 'no_workers_synced,clock_unsynchronized';
  const response = await t.fetch('/api/ingest/kiosks/last-sync', {
    method: 'POST',
    headers: { authorization: 'Bearer synthetic-only-ingest-key', 'content-type': 'application/json' },
    body: JSON.stringify({ kioskId: 'clock-entry', lastSync: now,
      health: { cameraOk: true, modelOk: true, degradedReason: reason } }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ updated: true });
  const kiosks = await t.withIdentity({ subject: userId }).query(api.kiosks.list, {});
  expect(kiosks[0].health?.degraded_reason).toBe(reason);
  const publicHealth = await t.fetch('/api/public/kiosk-health');
  expect(await publicHealth.json()).toMatchObject({ status: 'degraded', kiosks: { device_issues: 1 } });
});
