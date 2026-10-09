import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ConvexError } from 'convex/values';
import { BIOMETRIC_CONSENT_ERROR_CODE, BIOMETRIC_CONSENT_ERROR_MESSAGE, isRecentBiometricConsentAge } from '@/lib/biometric-consent';

const mocks = vi.hoisted(() => ({ query: vi.fn(), mutation: vi.fn(), action: vi.fn(), authorized: vi.fn(), fetch: vi.fn() }));
vi.mock('@/lib/convex', () => ({ default: { query: mocks.query, mutation: mocks.mutation, action: mocks.action } }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: mocks.authorized }));
import { POST } from './route';

const serverNow = Date.parse('2026-10-08T15:00:00.000Z');
const encodingResponse = () => Response.json({ encoding: Array(512).fill(0.1), used_photo_indexes: [0, 1, 2] });
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(serverNow);
  vi.stubGlobal('fetch', mocks.fetch);
  vi.stubEnv('FACE_SERVICE_KEY', 'synthetic');
  mocks.authorized.mockResolvedValue(true);
  mocks.query.mockResolvedValue(null);
  mocks.action.mockResolvedValue('synthetic-photo');
  mocks.mutation.mockResolvedValue({ id: 'synthetic-worker' });
  mocks.fetch.mockImplementation(async () => encodingResponse());
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function req(consentAgeMs: unknown, extra: Record<string, unknown> = {}) {
  return new NextRequest('https://synthetic.test/api/enroll', {
    method: 'POST',
    body: JSON.stringify({ name: 'Synthetic Employee', consent: true, consentAgeMs, photos: Array(3).fill('data:image/jpeg;base64,YQ=='), ...extra }),
  });
}

it.each([0, 30_000, 10 * 60_000])('derives acknowledgement time from the server clock and age %s', async consentAgeMs => {
  expect((await POST(req(consentAgeMs))).status).toBe(201);
  expect(mocks.mutation.mock.calls.find(c => c[1].faceEncoding)?.[1].consentAt)
    .toBe(new Date(serverNow - consentAgeMs).toISOString());
});
it.each([-60 * 60_000, 60 * 60_000])('ignores a legacy browser wall clock skewed by %s ms', async skew => {
  expect((await POST(req(30_000, { consentAt: new Date(serverNow + skew).toISOString() }))).status).toBe(201);
  expect(mocks.mutation.mock.calls.find(c => c[1].faceEncoding)?.[1].consentAt)
    .toBe(new Date(serverNow - 30_000).toISOString());
});
it.each([undefined, null, -1, 10 * 60_000 + 1, '30000', 'invalid', {}, true, 0.5, NaN, Infinity])(
  'rejects an invalid elapsed age before photo processing (%s)', async consentAgeMs => {
    const response = await POST(req(consentAgeMs));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: BIOMETRIC_CONSENT_ERROR_MESSAGE });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.action).not.toHaveBeenCalled();
    expect(mocks.mutation).not.toHaveBeenCalled();
  },
);
it.each([NaN, Infinity, -Infinity])('rejects non-finite ages even without JSON normalization (%s)', age => {
  expect(isRecentBiometricConsentAge(age)).toBe(false);
});
it('rejects a legacy timestamp-only request and an unchecked acknowledgement', async () => {
  expect((await POST(req(undefined, { consentAt: new Date(serverNow).toISOString() }))).status).toBe(400);
  expect((await POST(req(0, { consent: false }))).status).toBe(400);
});
it('preserves the derived time through encoding and uploads', async () => {
  mocks.fetch.mockImplementation(async () => { vi.setSystemTime(serverNow + 15_000); return encodingResponse(); });
  mocks.action.mockImplementation(async () => { vi.setSystemTime(Date.now() + 1000); return 'synthetic-photo'; });
  expect((await POST(req(30_000))).status).toBe(201);
  expect(mocks.mutation.mock.calls.find(c => c[1].faceEncoding)?.[1].consentAt)
    .toBe(new Date(serverNow - 30_000).toISOString());
});
it('rejects consent expiring during encoding before uploading photos', async () => {
  mocks.fetch.mockImplementation(async () => { vi.setSystemTime(serverNow + 1001); return encodingResponse(); });
  const response = await POST(req(10 * 60_000 - 1000));
  expect(response.status).toBe(400);
  expect((await response.json()).error).toContain('Confirm biometric consent again');
  expect(mocks.action).not.toHaveBeenCalled();
  expect(mocks.mutation).not.toHaveBeenCalled();
});
it('maps a structured mutation consent failure after slow uploads to 400 and cleans pending photos', async () => {
  mocks.action.mockImplementation(async () => { vi.setSystemTime(Date.now() + 1000); return 'synthetic-photo'; });
  const failure = new ConvexError({ code: BIOMETRIC_CONSENT_ERROR_CODE });
  failure.message = 'Server Error';
  mocks.mutation.mockRejectedValueOnce(failure).mockResolvedValueOnce(null);
  const response = await POST(req(10 * 60_000 - 1000));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: BIOMETRIC_CONSENT_ERROR_MESSAGE });
  expect(mocks.mutation.mock.calls.at(-1)?.[1]).toEqual({ storageIds: Array(3).fill('synthetic-photo') });
});
it('does not classify an unrelated mutation error as a consent failure', async () => {
  mocks.mutation.mockRejectedValueOnce(new ConvexError({ code: 'OTHER_ERROR', message: 'Biometric consent unrelated error' }));
  expect((await POST(req(0))).status).toBe(500);
});
