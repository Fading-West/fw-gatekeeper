/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { afterEach, expect, it, vi } from 'vitest';
import { api, internal } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.ts');
const encoding = Array.from({ length: 512 }, () => 0.1);
const t0 = Date.parse('2026-10-09T12:00:00.000Z');
afterEach(() => vi.useRealTimers());

async function setup() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(t0);
  const t = convexTest(schema, modules);
  const { userId, kioskId, workerId } = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { name: 'Admin' });
    await ctx.db.insert('portalMembers', { userId, role: 'admin', active: true, createdAt: new Date().toISOString() });
    const kioskId = await ctx.db.insert('kiosks', { name: 'Entry', type: 'pi', location: '', active: true, credentialHash: 'a'.repeat(64) });
    const workerId = await ctx.db.insert('workers', {
      name: 'Legacy worker', employeeId: 'F-77', department: 'Operations', active: true,
      enrolledAt: '2026-09-01T00:00:00.000Z', faceEncoding: encoding,
    });
    return { userId, kioskId, workerId };
  });
  const admin = t.withIdentity({ subject: userId });
  const issue = async () => (await t.mutation(internal.kiosks.issueRosterReceiptFromHttp, { documentId: kioskId }))!;
  const ack = (receipt: Awaited<ReturnType<typeof issue>>['receipt']) =>
    t.mutation(internal.kiosks.acknowledgeRosterReceiptFromHttp, { documentId: kioskId, receipt });
  const pending = async () => (await admin.query(api.kiosks.list, {}))[0].purge_pending;
  const sync = async (since?: string | null) => {
    const workers = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const page = await t.query(internal.workers.listForSyncFromHttp, { since: since ?? undefined, inclusive: true, cursor });
      workers.push(...page.workers);
      if (page.isDone) return workers;
      cursor = page.continueCursor;
    }
    throw new Error('Sync did not finish');
  };
  return { t, admin, kioskId, workerId, issue, ack, pending, sync };
}

it('keeps a later-committed purge pending and delivers it even when its timestamp precedes the receipt', async () => {
  const { t, admin, workerId, kioskId, issue, ack, pending, sync } = await setup();
  const issued = await issue();
  expect(await sync(issued.since)).toMatchObject([{ id: workerId, active: 1, face_encoding: encoding }]);
  // Model a mutation that started at P < T0 but commits after the roster read.
  vi.setSystemTime(t0 - 500);
  await admin.mutation(api.workers.purgeBiometrics, { id: workerId, reason: 'Retention request' });
  vi.setSystemTime(t0);
  expect((await t.run(ctx => ctx.db.get(workerId)))!.updatedAt! < issued.issuedAt).toBe(true);
  await ack(issued.receipt);
  expect.soft(await pending()).toBe(true);
  const next = await issue();
  expect.soft(next.since).toBe('seq:0');
  expect(await sync(next.since)).toMatchObject([{ id: workerId, active: 0, face_encoding: null }]);
  await ack(next.receipt);
  expect(await pending()).toBe(false);
  expect((await t.run(ctx => ctx.db.get(kioskId)))!.rosterAppliedSequence).toBe(1);
});

it('orders multiple purges by sequence, retains their marker after reenrollment, and ignores backwards clocks', async () => {
  const { admin, workerId, issue, ack, pending, sync } = await setup();
  await admin.mutation(api.workers.purgeBiometrics, { id: workerId, reason: 'First purge' });
  const first = await issue();
  await sync(first.since);
  await ack(first.receipt);
  expect(await pending()).toBe(false);
  vi.setSystemTime(t0 - 1000);
  await admin.mutation(api.workers.create, { name: 'Restored worker', employeeId: 'F-77', faceEncoding: encoding, consentAt: new Date().toISOString() });
  const before = await issue();
  await sync(before.since);
  vi.setSystemTime(t0 - 2000);
  await admin.mutation(api.workers.purgeBiometrics, { id: workerId, reason: 'Second purge' });
  await admin.mutation(api.workers.create, { name: 'Restored again', employeeId: 'F-77', faceEncoding: encoding, consentAt: new Date().toISOString() });
  await ack(before.receipt);
  expect(await pending()).toBe(true);
  const next = await issue();
  expect(await sync(next.since)).toMatchObject([{ id: workerId, name: 'Restored again', active: 1 }]);
  await ack(next.receipt);
  expect(await pending()).toBe(false);
});

it('transitions applied timestamps and old outstanding receipts through a full sequence sync', async () => {
  const { t, kioskId, workerId, admin, issue, ack, pending, sync } = await setup();
  const oldReceipt = await t.run(async ctx => {
    await ctx.db.patch(kioskId, { rosterAppliedAt: '2099-01-01T00:00:00.000Z' });
    return await ctx.db.insert('kioskRosterReceipts', { kioskId, issuedAt: new Date().toISOString() });
  });
  // Old response may already be in flight when the backend is upgraded.
  await admin.mutation(api.workers.purgeBiometrics, { id: workerId, reason: 'After old download' });
  const retry = await issue();
  expect(retry.receipt).toBe(oldReceipt);
  expect(retry.since).toBeNull();
  expect(await sync(retry.since)).toMatchObject([{ id: workerId, active: 0 }]);
  await ack(oldReceipt);
  expect(await pending()).toBe(true);
  expect((await t.run(ctx => ctx.db.get(kioskId)))!.rosterAppliedSequence).toBeUndefined();
  const fresh = await issue();
  expect(fresh.since).toBeNull();
  await sync(fresh.since);
  await ack(fresh.receipt);
  expect(await pending()).toBe(false);
  expect((await issue()).since).toBe('seq:1');
});

it('resends all legacy workers and inactive rows for any timestamp cursor without a backfill', async () => {
  const { t, admin, workerId, sync, issue, ack } = await setup();
  const initial = await issue();
  await sync(initial.since);
  await ack(initial.receipt);
  expect(await sync('seq:0')).toMatchObject([{ id: workerId, active: 1 }]);
  await admin.mutation(api.workers.remove, { id: workerId });
  for (const since of ['2099-01-01T00:00:00.000Z', '2026-10-09T12:00:00Z', 'garbage', 'seq:9007199254740992']) {
    expect(await sync(since)).toMatchObject([{ id: workerId, active: 0 }]);
  }
  expect((await t.run(ctx => ctx.db.get(workerId)))!.rosterSequence).toBe(1);
});

it('sequences create, deactivation, employee-ID reenrollment, metadata, templates, and photos', async () => {
  const { t, admin, issue, ack, sync } = await setup();
  const consentAt = new Date().toISOString();
  const created = await admin.mutation(api.workers.create, { name: 'New worker', employeeId: 'F-88', faceEncoding: encoding, consentAt });
  const first = await issue();
  await sync(first.since);
  await ack(first.receipt);
  vi.setSystemTime(t0 - 500);
  await admin.mutation(api.workers.remove, { id: created.id });
  const deactivated = await issue();
  expect(await sync(deactivated.since)).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.id, active: 0 })]));
  await ack(deactivated.receipt);
  const restored = await admin.mutation(api.workers.create, { name: 'Reenrolled worker', employeeId: 'F-88', faceEncoding: encoding, consentAt });
  expect(restored.id).toBe(created.id);
  const reEnrolled = await issue();
  expect(await sync(reEnrolled.since)).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.id, name: 'Reenrolled worker', active: 1, face_encoding: encoding })]));
  await ack(reEnrolled.receipt);
  for (const change of [{ department: 'New department' }, { faceEncoding: encoding, consentAt }, { photoStorageIds: [], consentAt }]) {
    const before = (await t.run(ctx => ctx.db.get(created.id)))!.rosterSequence!;
    await admin.mutation(api.workers.update, { id: created.id, ...change });
    expect((await t.run(ctx => ctx.db.get(created.id)))!.rosterSequence).toBe(before + 1);
    const receipt = await issue();
    expect(await sync(receipt.since)).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.id })]));
    await ack(receipt.receipt);
  }
});

it('routes seed and roster enrollment through the same counter', async () => {
  const t = convexTest(schema, modules);
  await t.mutation(internal.seed.run, {});
  const seeded = await t.run(ctx => ctx.db.query('workers').collect());
  expect(seeded.map(w => w.rosterSequence)).toEqual([1, 2, 3, 4, 5]);
  const userId = await t.run(async ctx => {
    const id = await ctx.db.insert('users', { name: 'Enrollment' });
    await ctx.db.insert('portalMembers', { userId: id, role: 'enrollment', active: true, createdAt: new Date().toISOString() });
    return id;
  });
  const enrolled = await t.withIdentity({ subject: userId }).mutation(api.workers.createFromRoster, {
    employeeId: 'F-2', faceEncoding: encoding, consentAt: new Date().toISOString(),
  });
  expect((await t.run(ctx => ctx.db.get(enrolled.id)))!.rosterSequence).toBe(6);
});

it('backfills bounded batches, resumes safely, and stops resending unchanged legacy encodings', async () => {
  const { t, issue, ack, sync } = await setup();
  vi.useFakeTimers();
  await t.run(async ctx => {
    for (let index = 0; index < 204; index++) {
      await ctx.db.insert('workers', {
        name: `Legacy ${index}`, department: '', active: index % 2 === 0,
        enrolledAt: '2026-09-01T00:00:00.000Z', faceEncoding: encoding,
      });
    }
  });
  const before = await t.run(ctx => ctx.db.query('workers').collect());
  const old = await issue();
  await sync(old.since);
  await ack(old.receipt);

  expect(await t.mutation(internal.workers.backfillRosterSequences, {}))
    .toEqual({ migrated: 100, isDone: false });
  expect(await t.run(ctx => ctx.db.query('workers')
    .withIndex('by_roster_sequence', q => q.eq('rosterSequence', undefined)).collect()))
    .toHaveLength(105);
  // A manual retry while continuation is queued must not rewrite earlier rows.
  const assigned = (await t.run(ctx => ctx.db.query('workers').collect()))
    .filter(w => w.rosterSequence !== undefined);
  expect(await t.mutation(internal.workers.backfillRosterSequences, {}))
    .toEqual({ migrated: 100, isDone: false });
  await t.finishAllScheduledFunctions(() => vi.runAllTimers());
  const after = await t.run(ctx => ctx.db.query('workers').collect());
  expect(after.map(worker => {
    const original = { ...worker };
    delete original.rosterSequence;
    return original;
  })).toEqual(before);
  expect(new Set(after.map(w => w.rosterSequence)).size).toBe(205);
  for (const worker of assigned) expect(after.find(w => w._id === worker._id)).toEqual(worker);
  expect(await t.mutation(internal.workers.backfillRosterSequences, {}))
    .toEqual({ migrated: 0, isDone: true });

  const next = await issue();
  expect(next.since).toBe('seq:0');
  expect(await sync(next.since)).toHaveLength(205);
  await ack(next.receipt);
  expect(await sync((await issue()).since)).toEqual([]);
});

it('keeps a purge after backfill pending when an earlier receipt is acknowledged', async () => {
  const { t, admin, workerId, issue, ack, pending, sync } = await setup();
  const old = await issue();
  await sync(old.since);
  expect(await t.mutation(internal.workers.backfillRosterSequences, {}))
    .toEqual({ migrated: 1, isDone: true });
  vi.setSystemTime(t0 - 500);
  await admin.mutation(api.workers.purgeBiometrics, { id: workerId, reason: 'During migration' });
  vi.setSystemTime(t0);
  await ack(old.receipt);
  expect(await pending()).toBe(true);
  const next = await issue();
  expect(await sync(next.since)).toMatchObject([{ id: workerId, active: 0, face_encoding: null }]);
  await ack(next.receipt);
  expect(await pending()).toBe(false);
  const counter = await t.run(ctx => ctx.db.query('rosterSequence').unique());
  expect(counter).toMatchObject({ value: 2, lastPurgeSequence: 2 });
  await t.mutation(internal.workers.backfillRosterSequences, {});
  expect(await t.run(ctx => ctx.db.query('rosterSequence').unique())).toEqual(counter);
});

it('retries rows moved out of the legacy phase by a backfill after the change phase ended', async () => {
  const { t, workerId, issue, ack, sync } = await setup();
  const initial = await issue();
  await sync(initial.since);
  await ack(initial.receipt);
  const current = await issue();
  expect(current.since).toBe('seq:0');
  const changes = await t.query(internal.workers.listForSyncFromHttp, { since: current.since! });
  expect(changes).toMatchObject({ workers: [], isDone: false, continueCursor: 'l:' });
  await t.mutation(internal.workers.backfillRosterSequences, {});
  const legacy = await t.query(internal.workers.listForSyncFromHttp, {
    since: current.since!, cursor: changes.continueCursor,
  });
  expect(legacy).toMatchObject({ workers: [], isDone: true });
  await ack(current.receipt);
  const next = await issue();
  expect(await sync(next.since)).toMatchObject([{ id: workerId }]);
  await ack(next.receipt);
  expect(await sync((await issue()).since)).toEqual([]);
});

it('covers assignments committed before receipt issuance even when they follow the prior ack', async () => {
  const { t, workerId, issue, ack, sync } = await setup();
  const initial = await issue();
  await sync(initial.since);
  await ack(initial.receipt);
  await t.mutation(internal.workers.backfillRosterSequences, {});
  const current = await issue();
  expect(current.since).toBe('seq:0');
  expect(await sync(current.since)).toMatchObject([{ id: workerId }]);
  await ack(current.receipt);
  expect(await sync((await issue()).since)).toEqual([]);
});

it('requires a newly registered kiosk to acknowledge the purge and lets its first full sync confirm it', async () => {
  const { t, admin, workerId, pending } = await setup();
  await admin.mutation(api.workers.purgeBiometrics, { id: workerId, reason: 'Before registration' });
  const created = await admin.mutation(api.kiosks.create, { name: 'New entry', type: 'pi' });
  await admin.mutation(api.kiosks.rotateCredential, { id: created.id, credentialHash: 'b'.repeat(64) });
  const list = () => admin.query(api.kiosks.list, {});
  expect((await list()).find(k => k.id === created.id)?.purge_pending).toBe(true);
  const issued = (await t.mutation(internal.kiosks.issueRosterReceiptFromHttp, { documentId: created.id }))!;
  expect(issued.since).toBeNull();
  expect((await t.query(internal.workers.listForSyncFromHttp, {})).workers)
    .toMatchObject([{ id: workerId, active: 0 }]);
  await t.mutation(internal.kiosks.acknowledgeRosterReceiptFromHttp, { documentId: created.id, receipt: issued.receipt });
  expect((await list()).find(k => k.id === created.id)?.purge_pending).toBe(false);
  expect(await pending()).toBe(true); // The original, never-acked kiosk still blocks.
});
