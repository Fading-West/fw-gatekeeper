/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { afterEach, expect, it, vi } from 'vitest';
import { api, internal } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.ts');
afterEach(() => vi.unstubAllEnvs());

async function setup() {
  const t = convexTest(schema, modules);
  const { first, second, adminId } = await t.run(async ctx => {
    const adminId = await ctx.db.insert('users', { name: 'Admin' });
    await ctx.db.insert('portalMembers', { userId: adminId, role: 'admin', active: true, createdAt: new Date().toISOString() });
    const first = await ctx.db.insert('kiosks', { name: 'Entry', kioskId: 'entry', type: 'pi', location: '', active: true, credentialHash: 'a'.repeat(64) });
    const second = await ctx.db.insert('kiosks', { name: 'Exit', kioskId: 'exit', type: 'pi', location: '', active: true, credentialHash: 'b'.repeat(64) });
    return { first, second, adminId };
  });
  return { t, first, second, adminId, admin: t.withIdentity({ subject: adminId }) };
}

it('binds one pending receipt to a kiosk, accepts a lost-response retry, and advances monotonically', async () => {
  const { t, first, second } = await setup();
  const issued = await t.mutation(internal.kiosks.issueRosterReceiptFromHttp, { documentId: first });
  expect(issued).not.toBeNull();
  expect(await t.mutation(internal.kiosks.issueRosterReceiptFromHttp, { documentId: first })).toEqual(issued);
  const receipt = issued!.receipt;
  expect(await t.mutation(internal.kiosks.acknowledgeRosterReceiptFromHttp, { documentId: second, receipt })).toEqual({ acknowledged: false, appliedAt: null });
  expect(await t.mutation(internal.kiosks.acknowledgeRosterReceiptFromHttp, { documentId: first, receipt })).toEqual({ acknowledged: true, appliedAt: issued!.issuedAt });
  expect(await t.mutation(internal.kiosks.acknowledgeRosterReceiptFromHttp, { documentId: first, receipt })).toEqual({ acknowledged: true, appliedAt: issued!.issuedAt });
  expect((await t.run(ctx => ctx.db.get(first)))?.rosterAppliedAt).toBe(issued!.issuedAt);
  const newer = await t.mutation(internal.kiosks.issueRosterReceiptFromHttp, { documentId: first });
  await t.mutation(internal.kiosks.acknowledgeRosterReceiptFromHttp, { documentId: first, receipt: newer!.receipt });
  expect((await t.run(ctx => ctx.db.get(first)))?.rosterAppliedAt! >= issued!.issuedAt).toBe(true);
});

it('rejects future, unknown, inactive, and wrong-device acknowledgements', async () => {
  const { t, first, second } = await setup();
  const future = await t.run(ctx => ctx.db.insert('kioskRosterReceipts', { kioskId: first, issuedAt: '2999-01-01T00:00:00Z' }));
  expect(await t.mutation(internal.kiosks.acknowledgeRosterReceiptFromHttp, { documentId: first, receipt: future })).toMatchObject({ acknowledged: false });
  expect(await t.mutation(internal.kiosks.acknowledgeRosterReceiptFromHttp, { documentId: second, receipt: future })).toMatchObject({ acknowledged: false });
  await t.run(ctx => ctx.db.patch(first, { active: false }));
  expect(await t.mutation(internal.kiosks.acknowledgeRosterReceiptFromHttp, { documentId: first, receipt: future })).toMatchObject({ acknowledged: false });
  const issued = await t.mutation(internal.kiosks.issueRosterReceiptFromHttp, { documentId: second });
  expect(issued).not.toBeNull();
  expect(await t.mutation(internal.kiosks.issueRosterReceiptFromHttp, { documentId: first })).toBeNull();
  vi.stubEnv('CONVEX_INGEST_KEY', 'test-ingest-key');
  const invalid = await t.fetch('/api/ingest/kiosks/roster-receipt/ack', {
    method: 'POST', headers: { authorization: 'Bearer test-ingest-key' },
    body: JSON.stringify({ documentId: second, receipt: 'not-a-receipt' }),
  });
  expect(invalid.status).toBe(400);
});

it('does not accept a kiosk device or migration key at the server-only receipt endpoints', async () => {
  const { t, first } = await setup();
  vi.stubEnv('CONVEX_INGEST_KEY', 'server-only-ingest-secret');
  for (const path of ['/api/ingest/kiosks/roster-receipt/issue', '/api/ingest/kiosks/roster-receipt/ack']) {
    for (const kioskKey of ['gkdev_device-secret', 'shared-migration-secret']) {
      const response = await t.fetch(path, { method: 'POST', headers: { authorization: `Bearer ${kioskKey}` },
        body: JSON.stringify({ documentId: first, receipt: 'forged' }) });
      expect(response.status).toBe(401);
    }
  }
  expect((await t.run(ctx => ctx.db.get(first)))?.rosterAppliedAt).toBeUndefined();
});

it('shows a purge pending until a later receipt is acknowledged, even with a recent heartbeat', async () => {
  const { t, first, adminId, admin } = await setup();
  const purgeAt = new Date().toISOString();
  await t.run(ctx => ctx.db.insert('auditLog', {
    actorUserId: adminId, action: 'workers.purgeBiometrics',
    targetTable: 'workers', targetId: 'worker', createdAt: purgeAt,
  }));
  await t.mutation(internal.kiosks.updateLastSyncFromHttp, { kioskId: 'entry', lastSync: purgeAt });
  expect((await admin.query(api.kiosks.list, {})).find(k => k.id === first)).toMatchObject({ purge_pending: true, roster_applied_at: null });
  const issued = await t.mutation(internal.kiosks.issueRosterReceiptFromHttp, { documentId: first });
  await t.mutation(internal.kiosks.acknowledgeRosterReceiptFromHttp, { documentId: first, receipt: issued!.receipt });
  const row = (await admin.query(api.kiosks.list, {})).find(k => k.id === first);
  expect(row?.roster_applied_at).toBeTruthy();
  // Equal millisecond timestamps stay pending, avoiding false certification.
  expect(row?.purge_pending).toBe(row!.roster_applied_at! <= purgeAt);
});
