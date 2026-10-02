/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getFunctionName } from 'convex/server';
import { api } from '../../../../convex/_generated/api';
import schema from '../../../../convex/schema';
import type { Id } from '../../../../convex/_generated/dataModel';

const mocks = vi.hoisted(() => ({ query: vi.fn(), mutation: vi.fn(), action: vi.fn() }));
vi.mock('@/lib/convex', () => ({ default: mocks }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: vi.fn(async () => true) }));
import { POST } from './route';
const modules = import.meta.glob('../../../../convex/**/*.ts');
const encoding = Array(512).fill(0.1);
const consentAt = '2026-10-02T12:00:00Z';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetAllMocks(); });

async function setup() {
  const test = convexTest(schema, modules);
  const userId = await test.run(async (ctx) => {
    const id = await ctx.db.insert('users', { email: 'synthetic-admin@example.test' });
    await ctx.db.insert('portalMembers', { userId: id, role: 'admin', active: true, createdAt: consentAt });
    return id;
  });
  const actor = test.withIdentity({ subject: userId });
  const legacy = await actor.action(api.enrollmentPhotos.upload, { photo: new TextEncoder().encode('old photo').buffer });
  const worker = await actor.mutation(api.workers.create, { name: 'Synthetic Worker', faceEncoding: encoding, photoStorageIds: [legacy], consentAt });
  const current = await actor.query(api.workers.get, { id: worker.id });
  const request = () => new NextRequest('https://synthetic.test/api/enroll', { method: 'POST', body: JSON.stringify({
    workerId: worker.id, expected_identity_revision: current!.identity_revision, name: 'Synthetic Worker', consent: true,
    photos: ['data:image/jpeg;base64,YQ==', 'data:image/jpeg;base64,Yg==', 'data:image/jpeg;base64,Yw=='],
  }) });
  mocks.query.mockImplementation((ref, args) => actor.query(ref, args));
  mocks.action.mockImplementation((ref, args) => actor.action(ref, args));
  mocks.mutation.mockImplementation((ref, args) => actor.mutation(ref, args));
  vi.stubEnv('FACE_SERVICE_KEY', 'synthetic-only');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ encoding: Array(512).fill(0.2), used_photo_indexes: [0,1,2] })));
  return { test, actor, legacy, worker, request };
}

it.each([0,1,2])('keeps persisted biometrics intact when upload %i fails and removes only pending files', async (failedIndex) => {
  const { test, actor, worker, legacy, request } = await setup();
  let index = 0;
  mocks.action.mockImplementation((ref, args) => index++ === failedIndex
    ? Promise.reject(new Error('Synthetic storage interruption')) : actor.action(ref, args));
  expect((await POST(request())).status).toBe(503);
  expect(await test.run((ctx) => ctx.db.get(worker.id as Id<'workers'>)))
    .toMatchObject({ faceEncoding: encoding, photoStorageIds: [legacy] });
  expect(await test.run((ctx) => ctx.storage.getUrl(legacy))).not.toBeNull();
  expect(await test.run((ctx) => ctx.db.query('pendingEnrollmentPhotos').collect())).toEqual([]);
});

it('preserves committed new photos after a lost save response and retains shared legacy attachments', async () => {
  const { test, actor, worker, legacy, request } = await setup();
  await test.run((ctx) => ctx.db.insert('workers', {
    name: 'Synthetic inactive legacy owner', department: '', active: false, enrolledAt: consentAt, photoStorageIds: [legacy],
  }));
  mocks.mutation.mockImplementation(async (ref, args) => {
    const result = await actor.mutation(ref, args);
    if (getFunctionName(ref) === 'workers:update') throw new Error('Synthetic response lost after commit');
    return result;
  });
  expect((await POST(request())).status).toBe(500);
  const stored = await test.run((ctx) => ctx.db.get(worker.id as Id<'workers'>));
  expect(stored!.faceEncoding).toEqual(Array(512).fill(0.2));
  expect(stored!.photoStorageIds).toHaveLength(3);
  for (const id of stored!.photoStorageIds!) expect(await test.run((ctx) => ctx.storage.getUrl(id))).not.toBeNull();
  expect(await test.run((ctx) => ctx.storage.getUrl(legacy))).not.toBeNull();
  expect(await test.run((ctx) => ctx.db.query('pendingEnrollmentPhotos').collect())).toEqual([]);
});
