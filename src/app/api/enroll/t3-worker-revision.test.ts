import { afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ConvexError } from 'convex/values';
const mocks = vi.hoisted(() => ({ query: vi.fn(), mutation: vi.fn(), action: vi.fn() }));
vi.mock('@/lib/convex', () => ({ default: mocks }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: async () => true }));
import { POST } from './route';
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it('returns a recoverable encoding-time identity conflict and cleans only pending uploads', async () => {
  mocks.query.mockResolvedValueOnce({ name: 'Synthetic', employee_id: 'S-1', department: 'Old', identity_revision: 'revision-before-encoding' }).mockResolvedValue(null);
  mocks.action.mockResolvedValueOnce('pending-photo-1').mockResolvedValueOnce('pending-photo-2');
  mocks.mutation.mockRejectedValueOnce(new ConvexError({ code: 'WORKER_IDENTITY_CONFLICT', message: 'Worker identity changed' })).mockResolvedValueOnce(null);
  vi.stubEnv('FACE_SERVICE_KEY', 'synthetic');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ encoding: Array(512).fill(.1), used_photo_indexes: [0, 1] })));
  const response = await POST(new NextRequest('https://synthetic.invalid/api/enroll', { method: 'POST', body: JSON.stringify({ workerId: 'synthetic-worker', expected_identity_revision: 'revision-before-encoding', name: 'Synthetic', employeeId: 'S-1', department: 'Old', consent: true, consentAgeMs: 0, photos: Array(3).fill('data:image/jpeg;base64,YQ==') }) }));
  expect(response.status).toBe(409);
  expect(mocks.mutation.mock.calls[0][1]).toMatchObject({ expectedIdentityRevision: 'revision-before-encoding' });
  expect(mocks.mutation.mock.calls.at(-1)?.[1]).toEqual({ storageIds: ['pending-photo-1', 'pending-photo-2'] });
});

it.each([undefined, 'stale-revision'])('rejects missing or stale pre-capture revisions before processing photos (%s)', async (revision) => {
  mocks.query.mockResolvedValue({ name: 'Current', department: 'Mill', identity_revision: 'current-revision' });
  const encode = vi.fn();
  vi.stubGlobal('fetch', encode);
  const response = await POST(new NextRequest('https://synthetic.invalid/api/enroll', { method: 'POST', body: JSON.stringify({ workerId: 'synthetic-worker', expected_identity_revision: revision, name: 'Stale directory name', consent: true, consentAgeMs: 0, photos: Array(3).fill('data:image/jpeg;base64,YQ==') }) }));
  expect(response.status).toBe(409);
  expect(encode).not.toHaveBeenCalled();
  expect(mocks.action).not.toHaveBeenCalled();
  expect(mocks.mutation).not.toHaveBeenCalled();
});
