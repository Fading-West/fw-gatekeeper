import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  query: vi.fn(), mutation: vi.fn(), action: vi.fn(), authorized: vi.fn(), fetch: vi.fn(),
}));
vi.mock('@/lib/convex', () => ({ default: { query: mocks.query, mutation: mocks.mutation, action: mocks.action } }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: mocks.authorized }));
import { POST } from './route';

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
  vi.stubEnv('FACE_SERVICE_KEY', 'test');
  mocks.authorized.mockResolvedValue(true);
  mocks.query.mockResolvedValue(null);
  mocks.action.mockResolvedValueOnce('photo-b').mockResolvedValueOnce('photo-c');
  mocks.mutation.mockResolvedValue({ id: 'worker' });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function request(photos: unknown = ['data:image/jpeg;base64,YQ==','data:image/jpeg;base64,Yg==','data:image/jpeg;base64,Yw==']) {
  return new NextRequest('https://example.test/api/enroll', { method: 'POST', body: JSON.stringify({ name: 'Test Worker', photos, consent: true }) });
}
it('stores only photo indexes used by the quality gate', async () => {
  mocks.fetch.mockResolvedValueOnce(Response.json({ encoding: Array(512).fill(0.1), used_photo_indexes: [1,2] }));
  const response = await POST(request());
  expect(response.status).toBe(201);
  expect(Buffer.from(mocks.action.mock.calls[0][1].photo).toString()).toBe('b');
  expect(Buffer.from(mocks.action.mock.calls[1][1].photo).toString()).toBe('c');
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  expect(mocks.mutation.mock.calls.at(-1)?.[1]).toEqual({ storageIds: ['photo-b', 'photo-c'] });
});
it('rejects malformed photo arrays before calling the encoding service', async () => {
  expect((await POST(request([{}, {}, {}]))).status).toBe(400);
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it('rejects an invalid accepted-index response before any storage write', async () => {
  mocks.fetch.mockResolvedValueOnce(Response.json({ encoding: Array(512).fill(0.1), used_photo_indexes: [0,99] }));
  expect((await POST(request())).status).toBe(503);
  expect(mocks.mutation).not.toHaveBeenCalled();
});

it.each([undefined, 'all'])('rejects absent or malformed quality metadata (%s)', async (indexes) => {
  mocks.fetch.mockResolvedValueOnce(Response.json({ encoding: Array(512).fill(0.1), used_photo_indexes: indexes }));
  expect((await POST(request())).status).toBe(503);
  expect(mocks.mutation).not.toHaveBeenCalled();
});

it('requests safe pending cleanup when the worker save fails or its response is lost', async () => {
  mocks.fetch.mockResolvedValueOnce(Response.json({ encoding: Array(512).fill(0.1), used_photo_indexes: [1,2] }));
  mocks.mutation.mockRejectedValueOnce(new Error('Save response lost')).mockResolvedValueOnce(null);
  expect((await POST(request())).status).toBe(500);
  expect(mocks.mutation.mock.calls.at(-1)?.[1]).toEqual({ storageIds: ['photo-b', 'photo-c'] });
});
it('does not mask a successful save when immediate cleanup is unavailable', async () => {
  mocks.fetch.mockResolvedValueOnce(Response.json({ encoding: Array(512).fill(0.1), used_photo_indexes: [1,2] }));
  mocks.mutation.mockResolvedValueOnce({ id: 'worker' }).mockRejectedValueOnce(new Error('Cleanup unavailable'));
  expect((await POST(request())).status).toBe(201);
});

it.each([0, 1, 2])('does not save a partial enrollment when accepted upload %i fails', async (failedIndex) => {
  mocks.fetch.mockResolvedValueOnce(Response.json({ encoding: Array(512).fill(0.1), used_photo_indexes: [0,1,2] }));
  mocks.action.mockReset();
  for (let index = 0; index < failedIndex; index++) mocks.action.mockResolvedValueOnce(`owned-${index}`);
  mocks.action.mockRejectedValueOnce(new Error('Synthetic storage outage'));
  const response = await POST(request());
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: 'ENROLLMENT_PHOTO_STORAGE_UNAVAILABLE' });
  expect(mocks.action).toHaveBeenCalledTimes(failedIndex + 1);
  expect(mocks.mutation.mock.calls.map(([, args]) => args)).toEqual(failedIndex
    ? [{ storageIds: Array.from({ length: failedIndex }, (_, index) => `owned-${index}`) }] : []);
});

it('preserves the existing template and photos when reenrollment storage fails', async () => {
  const previous = { id: 'worker', name: 'Test Worker', active: true, identity_revision: 'seen', photos: ['legacy-photo'] };
  mocks.query.mockResolvedValue(previous);
  mocks.fetch.mockResolvedValueOnce(Response.json({ encoding: Array(512).fill(0.1), used_photo_indexes: [1,2] }));
  mocks.action.mockReset().mockResolvedValueOnce('new-photo').mockRejectedValueOnce(new Error('Synthetic outage'));
  const response = await POST(new NextRequest('https://example.test/api/enroll', { method: 'POST', body: JSON.stringify({
    name: 'Test Worker', workerId: 'worker', expected_identity_revision: 'seen', consent: true,
    photos: ['data:image/jpeg;base64,YQ==','data:image/jpeg;base64,Yg==','data:image/jpeg;base64,Yw=='],
  }) }));
  expect(response.status).toBe(503);
  expect(mocks.mutation.mock.calls.map(([, args]) => args)).toEqual([{ storageIds: ['new-photo'] }]);
  expect(previous.photos).toEqual(['legacy-photo']);
});

it('rejects an unauthorized role before processing or creating storage', async () => {
  mocks.authorized.mockResolvedValue(false);
  expect((await POST(request())).status).toBe(401);
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.action).not.toHaveBeenCalled();
  expect(mocks.mutation).not.toHaveBeenCalled();
});
