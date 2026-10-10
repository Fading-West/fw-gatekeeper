/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { expect, it, vi } from 'vitest';
import { internal } from './_generated/api';
import schema from './schema';
import { listForSyncFromHttp } from './workers';

const modules = import.meta.glob('./**/*.ts');

it.each([
  { mode: 'full', since: undefined, inclusive: false },
  { mode: 'incremental', since: '2026-09-20T00:00:00Z', inclusive: false },
  { mode: 'inclusive incremental', since: '2026-09-26T00:00:00Z', inclusive: true },
  { mode: 'legacy full', since: '1970-01-01T00:00:00.000Z', inclusive: false },
])('omits inactive biometrics and preserves active workers in $mode sync', async ({ since, inclusive }) => {
  const t = convexTest(schema, modules);
  const encoding = Array.from({ length: 512 }, () => 0.1);
  const enrolledAt = '2026-09-26T00:00:00Z';
  const { activeId, inactiveIds, photoUrl } = await t.run(async ctx => {
    const photoId = await ctx.storage.store(new Blob(['photo'], { type: 'image/jpeg' }));
    const fields = { name: 'Worker', employeeId: 'F-77', department: 'Operations',
      faceEncoding: encoding, photoStorageIds: [photoId], enrolledAt };
    const activeId = await ctx.db.insert('workers', { ...fields, active: true, updatedAt: enrolledAt });
    // Cover both indexed change rows and older rows without updatedAt.
    const inactiveIds = [
      await ctx.db.insert('workers', { ...fields, active: false, updatedAt: enrolledAt }),
      await ctx.db.insert('workers', { ...fields, active: false }),
    ];
    return { activeId, inactiveIds, photoUrl: await ctx.storage.getUrl(photoId) };
  });
  expect(photoUrl).not.toBeNull();

  const workers = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 5; pages++) {
    const page = await t.query(internal.workers.listForSyncFromHttp, { since, inclusive, cursor });
    workers.push(...page.workers);
    if (page.isDone) break;
    cursor = page.continueCursor;
    if (pages === 4) throw new Error('Worker sync pagination did not finish');
  }
  const metadata = { name: 'Worker', employee_id: 'F-77', department: 'Operations',
    enrolled_at: enrolledAt, updated_at: enrolledAt };
  expect(workers).toHaveLength(3);
  expect(workers.find(worker => worker.id === activeId)).toEqual({
    ...metadata, id: activeId, active: 1, face_encoding: encoding, photo_url: photoUrl,
  });
  for (const id of inactiveIds) {
    // Exact shape also guards against leaking storage IDs or other photo fields.
    expect(workers.find(worker => worker.id === id)).toEqual({
      ...metadata, id, active: 0, face_encoding: null, photo_url: null,
    });
    await t.run(async ctx => {
      // Deactivation still retains cloud biometrics until explicit purge.
      const worker = await ctx.db.get(id);
      expect(worker!.faceEncoding).toEqual(encoding);
      expect(worker!.photoStorageIds).toHaveLength(1);
    });
  }
});

it('does not resolve storage URLs for inactive workers', async () => {
  const t = convexTest(schema, modules);
  await t.run(async ctx => {
    const photoId = await ctx.storage.store(new Blob(['photo'], { type: 'image/jpeg' }));
    await ctx.db.insert('workers', { name: 'Inactive', department: 'Operations', active: false,
      faceEncoding: [0.1], photoStorageIds: [photoId], enrolledAt: '2026-09-26T00:00:00Z' });
    const getUrl = vi.spyOn(ctx.storage, 'getUrl');
    try {
      // Invoke the registered handler with this context so the storage spy observes it.
      const handler = (listForSyncFromHttp as unknown as {
        _handler: (ctx: unknown, args: object) => Promise<{ workers: unknown[] }>;
      })._handler;
      const page = await handler(ctx, {});
      expect(page.workers).toMatchObject([{ active: 0, face_encoding: null, photo_url: null }]);
      expect(getUrl).not.toHaveBeenCalled();
    } finally {
      getUrl.mockRestore();
    }
  });
});
