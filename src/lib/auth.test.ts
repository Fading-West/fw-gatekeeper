import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasValidKioskKey } from './auth';

const request = (headers: Record<string, string> = {}) => new NextRequest('http://localhost/api/attendance', { method: 'POST', headers });
afterEach(() => vi.unstubAllEnvs());

describe('kiosk credentials', () => {
  describe.each(['authorization', 'x-kiosk-key'])('%s header', (header) => {
    const credentialRequest = (key: string) => request({
      [header]: header === 'authorization' ? `Bearer ${key}` : key,
    });

    it('accepts the configured key', () => {
      vi.stubEnv('KIOSK_API_KEY', 'test-kiosk-key');
      expect(hasValidKioskKey(credentialRequest('test-kiosk-key'))).toBe(true);
    });

    it.each(['test-kiosk-kex', 'short', 'test-kiosk-key-with-extra-characters', ''])(
      'rejects a mismatched key (%j) without throwing', (key) => {
        vi.stubEnv('KIOSK_API_KEY', 'test-kiosk-key');
        expect(hasValidKioskKey(credentialRequest(key))).toBe(false);
      },
    );

    it.each([undefined, '', '   '])('fails closed with an unconfigured secret (%j)', (secret) => {
      vi.stubEnv('KIOSK_API_KEY', secret);
      vi.stubEnv('FW_ALLOW_UNCONFIGURED_KIOSK_KEY', '');
      expect(hasValidKioskKey(credentialRequest('test-kiosk-key'))).toBe(false);
    });
  });

  it('rejects a missing header when a secret is configured', () => {
    vi.stubEnv('KIOSK_API_KEY', 'test-kiosk-key');
    expect(hasValidKioskKey(request())).toBe(false);
  });

  it('accepts a valid x-kiosk-key when the bearer credential is wrong', () => {
    vi.stubEnv('KIOSK_API_KEY', 'test-kiosk-key');
    expect(hasValidKioskKey(request({
      authorization: 'Bearer wrong',
      'x-kiosk-key': 'test-kiosk-key',
    }))).toBe(true);
  });

  it.each(['development', 'test', 'production'])('fails closed without a configured key in %s', (environment) => {
    vi.stubEnv('NODE_ENV', environment);
    vi.stubEnv('KIOSK_API_KEY', '');
    vi.stubEnv('FW_ALLOW_UNCONFIGURED_KIOSK_KEY', '');
    expect(hasValidKioskKey(request())).toBe(false);
  });

  it('allows an explicit local override but never a production override', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('KIOSK_API_KEY', '');
    vi.stubEnv('FW_ALLOW_UNCONFIGURED_KIOSK_KEY', 'true');
    expect(hasValidKioskKey(request())).toBe(true);
    vi.stubEnv('NODE_ENV', 'production');
    expect(hasValidKioskKey(request())).toBe(false);
  });

  it('requires the configured credential even when local override is enabled', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('KIOSK_API_KEY', 'test-kiosk-key');
    vi.stubEnv('FW_ALLOW_UNCONFIGURED_KIOSK_KEY', 'true');
    expect(hasValidKioskKey(request())).toBe(false);
    expect(hasValidKioskKey(request({ 'x-kiosk-key': 'wrong' }))).toBe(false);
    expect(hasValidKioskKey(request({ 'x-kiosk-key': 'test-kiosk-key' }))).toBe(true);
    expect(hasValidKioskKey(request({ authorization: 'Bearer test-kiosk-key' }))).toBe(true);
  });
});
