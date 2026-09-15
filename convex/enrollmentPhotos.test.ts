/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from './_generated/api';
import schema from './schema';
import type { Id } from './_generated/dataModel';
const modules = import.meta.glob('./**/*.ts');
const encoding = Array(512).fill(0.1);
const consentAt = '2026-09-15T12:00:00Z';

async function setup() {
  const t = convexTest(schema, modules);
  const [ownerId, otherId, viewerId] = await t.run(async (ctx) => {
    const users = [];
    for (const role of ['admin', 'enrollment', 'viewer'] as const) {
      const userId = await ctx.db.insert('users', { email: `${role}@example.test` });
      await ctx.db.insert('portalMembers', { userId, role, active: true, createdAt: consentAt });
      users.push(userId);
    }
    return users;
  });
  const owner = t.withIdentity({ subject: ownerId });
  const other = t.withIdentity({ subject: otherId });
  const viewer = t.withIdentity({ subject: viewerId });
  const upload = () => owner.action(api.enrollmentPhotos.upload, { photo: new TextEncoder().encode('photo').buffer });
  const create = (photoStorageIds: Awaited<ReturnType<typeof upload>>[]) => owner.mutation(api.workers.create, {
    name: 'Photo Worker', faceEncoding: encoding, consentAt, photoStorageIds,
  });
  return { t, owner, other, viewer, upload, create };
}

afterEach(() => vi.useRealTimers());

describe('pending enrollment photo lifecycle', () => {
  it('cleans failed saves, including inactive re-enrollment, and cannot attach deleted photos later', async () => {
    const { t, owner, upload, create } = await setup();
    const worker = await create([]);
    await owner.mutation(api.workers.remove, { id: worker.id });
    const storageId = await upload();
    await expect(owner.mutation(api.workers.update, { id: worker.id, faceEncoding: encoding, consentAt, photoStorageIds: [storageId] })).rejects.toThrow('Active worker not found');
    await owner.mutation(api.enrollmentPhotos.cleanup, { storageIds: [storageId] });
    expect(await t.run((ctx) => ctx.storage.getUrl(storageId))).toBeNull();
    await expect(owner.mutation(api.workers.create, { name: 'New Worker', faceEncoding: encoding, consentAt, photoStorageIds: [storageId] })).rejects.toThrow('no longer exists');
    expect(await t.run((ctx) => ctx.db.query('pendingEnrollmentPhotos').collect())).toHaveLength(0);
  });

  it('preserves attached photos when a committed save response is lost and cleanup runs', async () => {
    const { t, owner, upload, create } = await setup();
    const storageId = await upload();
    const worker = await create([storageId]);
    await owner.mutation(api.enrollmentPhotos.cleanup, { storageIds: [storageId] });
    expect(await t.run((ctx) => ctx.storage.getUrl(storageId))).not.toBeNull();
    expect((await t.run((ctx) => ctx.db.get(worker.id as Id<"workers">)))?.photoStorageIds).toEqual([storageId]);
    expect(await t.run((ctx) => ctx.db.query('pendingEnrollmentPhotos').collect())).toHaveLength(0);
  });

  it('atomically consumes uploads on update and restores pending state when save validation fails', async () => {
    const { t, owner, upload, create } = await setup();
    const worker = await create([]);
    const storageId = await upload();
    await expect(owner.mutation(api.workers.update, { id: worker.id, faceEncoding: [1], consentAt, photoStorageIds: [storageId] })).rejects.toThrow('512');
    expect(await t.run((ctx) => ctx.db.query('pendingEnrollmentPhotos').collect())).toHaveLength(1);
    await owner.mutation(api.workers.update, { id: worker.id, faceEncoding: encoding, consentAt, photoStorageIds: [storageId] });
    await owner.mutation(api.enrollmentPhotos.cleanup, { storageIds: [storageId] });
    expect(await t.run((ctx) => ctx.storage.getUrl(storageId))).not.toBeNull();
  });

  it('rejects another uploader claiming or cleaning pending photos, and denies viewers and anonymous users', async () => {
    const { t, owner, other, viewer, upload, create } = await setup();
    const worker = await create([]);
    const storageId = await upload();
    await expect(other.mutation(api.enrollmentPhotos.cleanup, { storageIds: [storageId] })).rejects.toThrow('another user');
    await expect(other.mutation(api.workers.update, { id: worker.id, faceEncoding: encoding, consentAt, photoStorageIds: [storageId] })).rejects.toThrow('another user');
    for (const caller of [t, viewer]) {
      await expect(caller.action(api.enrollmentPhotos.upload, { photo: new ArrayBuffer(1) })).rejects.toThrow();
      await expect(caller.mutation(api.enrollmentPhotos.cleanup, { storageIds: [storageId] })).rejects.toThrow();
    }
    expect(await t.run((ctx) => ctx.storage.getUrl(storageId))).not.toBeNull();
    await owner.mutation(api.enrollmentPhotos.cleanup, { storageIds: [storageId] });
  });

  it('never deletes arbitrary or legacy attached storage IDs through cleanup', async () => {
    const { t, owner, create } = await setup();
    const legacyId = await t.run((ctx) => ctx.storage.store(new Blob(['legacy'])));
    await create([legacyId]);
    await owner.mutation(api.enrollmentPhotos.cleanup, { storageIds: [legacyId] });
    expect(await t.run((ctx) => ctx.storage.getUrl(legacyId))).not.toBeNull();
  });

  it('eventually deletes abandoned uploads even if the upload response never reaches the route', async () => {
    vi.useFakeTimers();
    const { t, upload } = await setup();
    const storageId = await upload(); // Simulate lost response: no route cleanup follows.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.storage.getUrl(storageId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.query('pendingEnrollmentPhotos').collect())).toHaveLength(0);
  });

  it('expiry cannot delete photos claimed by a successful worker save', async () => {
    vi.useFakeTimers();
    const { t, upload, create } = await setup();
    const storageId = await upload();
    await create([storageId]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.storage.getUrl(storageId))).not.toBeNull();
  });

  it('rejects expired uploads before scheduled cleanup and cannot race expiry to attach deleted photos', async () => {
    vi.useFakeTimers();
    const { t, upload, create } = await setup();
    const storageId = await upload();
    vi.setSystemTime(Date.now() + 60 * 60 * 1000 + 1);
    await expect(create([storageId])).rejects.toThrow('expired');
    const pending = await t.run((ctx) => ctx.db.query('pendingEnrollmentPhotos').unique());
    await t.mutation(internal.enrollmentPhotos.expire, { id: pending!._id });
    await expect(create([storageId])).rejects.toThrow('no longer exists');
  });
});
