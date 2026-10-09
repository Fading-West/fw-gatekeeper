import { afterEach, expect, it, vi } from 'vitest';
import { biometricConsentAgeMs, BIOMETRIC_CONSENT_CLOCK_TOLERANCE_MS, isRecentBiometricConsentAge } from './biometric-consent';

afterEach(() => vi.restoreAllMocks());

it.each([-1, 1])('rejects clock disagreement just beyond tolerance in direction %s', direction => {
  vi.spyOn(performance, 'now').mockReturnValue(30_000);
  vi.spyOn(Date, 'now').mockReturnValue(30_000 + direction * (BIOMETRIC_CONSENT_CLOCK_TOLERANCE_MS + 1));
  const age = biometricConsentAgeMs({ monotonicMs: 0, wallMs: 0 });
  expect(age).toBeNull();
  expect(isRecentBiometricConsentAge(age)).toBe(false);
});

it('rounds the larger trusted elapsed duration up to whole milliseconds', () => {
  vi.spyOn(performance, 'now').mockReturnValue(100.1);
  vi.spyOn(Date, 'now').mockReturnValue(100);
  expect(biometricConsentAgeMs({ monotonicMs: 0, wallMs: 0 })).toBe(101);
});
