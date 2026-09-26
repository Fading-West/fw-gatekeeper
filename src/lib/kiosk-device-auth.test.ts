import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { lookupKioskCredential } from './convex-ingest';
import { authenticateKiosk, kioskClaims } from './kiosk-device-auth';

vi.mock('./convex-ingest', () => ({ lookupKioskCredential: vi.fn() }));
const identity = { kioskId: 'entry', aliases: ['entry', 'Front', 'kiosk-document'] };
const request = (key?: string) => new NextRequest('http://localhost/api/sync', { headers: key ? { 'x-kiosk-key': key } : {} });
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('KIOSK_API_KEY', 'shared-key'); });
afterEach(() => vi.unstubAllEnvs());

it('requires a registered kiosk even when the shared key is valid', async () => {
  vi.mocked(lookupKioskCredential).mockResolvedValue(null);
  expect(await authenticateKiosk(request('shared-key'), ['unknown'])).toBeNull();
  expect(await authenticateKiosk(request('wrong-key'), ['entry'])).toBeNull();
  expect(await authenticateKiosk(request(), ['entry'])).toBeNull();
});

it('binds a device secret to the stored hash and canonical kiosk ID', async () => {
  const secret = `gkdev_${'a'.repeat(43)}`;
  vi.mocked(lookupKioskCredential).mockResolvedValue(identity);
  expect(await authenticateKiosk(request(secret), ['Front', 'entry'])).toEqual(identity);
  expect(vi.mocked(lookupKioskCredential).mock.calls[0][0]).toEqual({ mode: 'device', credentialHash: createHash('sha256').update(secret).digest('hex') });
  expect(await authenticateKiosk(request(secret), ['other'])).toBeNull();
});

it('rejects every conflicting or malformed snake and camel alias in a batch', async () => {
  vi.mocked(lookupKioskCredential).mockResolvedValue(identity);
  const top = { kiosk_id: 'entry', kioskId: 'Front' };
  const good = { kiosk_id: 'Front' };
  const bad = { kiosk_id: 'entry', kioskId: 'other' };
  expect(await authenticateKiosk(request('shared-key'), [...kioskClaims(top), ...kioskClaims(good)])).toEqual(identity);
  expect(await authenticateKiosk(request('shared-key'), [...kioskClaims(top), ...kioskClaims(bad)])).toBeNull();
  expect(await authenticateKiosk(request('shared-key'), [...kioskClaims(top), ...kioskClaims({ kiosk_id: 42 })])).toBeNull();
});
