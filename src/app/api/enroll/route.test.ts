import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  query: vi.fn(), mutation: vi.fn(), authorized: vi.fn(), fetch: vi.fn(),
}));
vi.mock('@/lib/convex', () => ({ default: { query: mocks.query, mutation: mocks.mutation } }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: mocks.authorized }));
import { POST } from './route';

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
  vi.stubEnv('FACE_SERVICE_KEY', 'test');
  mocks.authorized.mockResolvedValue(true);
  mocks.query.mockResolvedValue(null);
  mocks.mutation.mockResolvedValueOnce('https://storage.test/upload').mockResolvedValueOnce('https://storage.test/upload').mockResolvedValueOnce({ id: 'worker' });
});
function request(photos: unknown = ['data:image/jpeg;base64,YQ==','data:image/jpeg;base64,Yg==','data:image/jpeg;base64,Yw==']) {
  return new NextRequest('https://example.test/api/enroll', { method: 'POST', body: JSON.stringify({ name: 'Test Worker', photos, consent: true }) });
}
it('stores only photo indexes used by the quality gate', async () => {
  mocks.fetch.mockResolvedValueOnce(Response.json({ encoding: Array(512).fill(0.1), used_photo_indexes: [1,2] }));
  mocks.fetch.mockResolvedValueOnce(Response.json({ storageId: 'photo-b' })).mockResolvedValueOnce(Response.json({ storageId: 'photo-c' }));
  const response = await POST(request());
  expect(response.status).toBe(201);
  expect(await mocks.fetch.mock.calls[1][1].body.text()).toBe('b');
  expect(await mocks.fetch.mock.calls[2][1].body.text()).toBe('c');
  expect(mocks.fetch).toHaveBeenCalledTimes(3);
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
