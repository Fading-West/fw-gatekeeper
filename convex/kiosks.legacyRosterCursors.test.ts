/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { afterEach, expect, it, vi } from 'vitest';
import { api, internal } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.ts');
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

async function setup() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-10-09T12:00:00.000Z');
  const t = convexTest(schema, modules);
  const { kioskId, otherId, userId, workerId } = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { name: 'Admin' });
    await ctx.db.insert('portalMembers', { userId, role: 'admin', active: true, createdAt: new Date().toISOString() });
    const fields = { name: 'Entry', type: 'pi', location: '', active: true };
    const kioskId = await ctx.db.insert('kiosks', fields);
    const otherId = await ctx.db.insert('kiosks', fields);
    const workerId = await ctx.db.insert('workers', { name: 'Legacy worker', department: '', active: true,
      enrolledAt: '2026-09-01T00:00:00.000Z', faceEncoding: Array.from({ length: 512 }, () => 0.1) });
    return { kioskId, otherId, userId, workerId };
  });
  const admin = t.withIdentity({ subject: userId });
  const issue = async (since?: string, documentId = kioskId) =>
    (await t.mutation(internal.kiosks.issueLegacyRosterCursorFromHttp, { documentId, since }))!;
  const sync = async (since: string | null) => {
    const workers = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const page = await t.query(internal.workers.listForSyncFromHttp, { since: since ?? undefined, cursor });
      workers.push(...page.workers);
      if (page.isDone) return workers;
      cursor = page.continueCursor;
    }
    throw new Error('Sync did not finish');
  };
  return { t, admin, kioskId, otherId, workerId, issue, sync };
}

it('transitions shared-key timestamps to sequence deltas and delivers a racing purge without confirming it', async () => {
  const { t, admin, kioskId, workerId, issue, sync } = await setup();
  await t.mutation(internal.workers.backfillRosterSequences, {});
  const first = await issue('2099-01-01T00:00:00.000Z');
  expect(first.since).toBeNull();
  expect(await sync(first.since)).toMatchObject([{ id: workerId, active: 1 }]);
  const empty = await issue(first.issuedAt);
  expect(empty.since).toBe('seq:1');
  expect(await sync(empty.since)).toEqual([]);
  vi.setSystemTime('2026-10-09T11:59:59.000Z');
  await admin.mutation(api.workers.purgeBiometrics, { id: workerId, reason: 'After download' });
  const next = await issue(empty.issuedAt);
  expect(next.issuedAt > empty.issuedAt).toBe(true);
  expect(await sync(next.since)).toMatchObject([{ id: workerId, active: 0, face_encoding: null }]);
  expect((await admin.query(api.kiosks.list, {})).find(k => k.id === kioskId)?.purge_pending).toBe(true);
  expect((await t.run(ctx => ctx.db.get(kioskId)))?.rosterAppliedSequence).toBeUndefined();
  expect(await t.run(ctx => ctx.db.query('kioskRosterReceipts').collect())).toEqual([]);
});

it('keeps cursor history bounded and falls back to full sync for evicted, forged, and other-device cursors', async () => {
  const { t, kioskId, otherId, issue } = await setup();
  const first = await issue();
  const second = await issue(first.issuedAt);
  expect(second.issuedAt).not.toBe(first.issuedAt);
  expect((await issue(first.issuedAt, otherId)).since).toBeNull();
  // Retry after one failed response retains the old boundary.
  expect((await issue(first.issuedAt)).since).toBe('seq:0');
  expect((await issue(first.issuedAt)).since).toBeNull();
  for (const since of ['seq:999', '2099-01-01T00:00:00Z', 'garbage']) {
    expect((await issue(since)).since).toBeNull();
  }
  expect((await t.run(ctx => ctx.db.get(kioskId)))?.legacyRosterCursors).toHaveLength(2);
  await t.run(ctx => ctx.db.patch(kioskId, { active: false }));
  expect(await t.mutation(internal.kiosks.issueLegacyRosterCursorFromHttp, { documentId: kioskId })).toBeNull();
});

it('delivers legacy rows when backfill assigns their sequence after cursor issuance', async () => {
  const { t, workerId, issue, sync } = await setup();
  const first = await issue();
  await sync(first.since);
  await t.mutation(internal.workers.backfillRosterSequences, {});
  const next = await issue(first.issuedAt);
  expect(next.since).toBe('seq:0');
  expect(await sync(next.since)).toMatchObject([{ id: workerId }]);
  expect(await sync((await issue(next.issuedAt)).since)).toEqual([]);
});

it('does not promote an old timestamp if a failed first response is issued at the same clock value', async () => {
  const { t, workerId, issue, sync } = await setup();
  await t.mutation(internal.workers.backfillRosterSequences, {});
  const old = '2026-10-09T12:00:00.000Z';
  const failed = await issue(old);
  expect(failed.issuedAt).not.toBe(old);
  const retry = await issue(old);
  expect(retry.since).toBeNull();
  expect(await sync(retry.since)).toMatchObject([{ id: workerId }]);
});

it('requires the server-only ingest credential and rejects invalid kiosk IDs', async () => {
  const { t, kioskId } = await setup();
  vi.stubEnv('CONVEX_INGEST_KEY', 'server-only');
  const path = '/api/ingest/kiosks/legacy-roster-cursor/issue';
  for (const key of ['shared-key', 'gkdev_device-key']) {
    expect((await t.fetch(path, { method: 'POST', headers: { authorization: `Bearer ${key}` },
      body: JSON.stringify({ documentId: kioskId }) })).status).toBe(401);
  }
  expect((await t.fetch(path, { method: 'POST', headers: { authorization: 'Bearer server-only' },
    body: JSON.stringify({ documentId: 'invalid' }) })).status).toBe(400);
  const response = await t.fetch(path, { method: 'POST', headers: { authorization: 'Bearer server-only' },
    body: JSON.stringify({ documentId: kioskId }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ since: null });
});
