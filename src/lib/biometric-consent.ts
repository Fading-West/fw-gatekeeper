export const BIOMETRIC_CONSENT_MAX_AGE_MS = 10 * 60_000;
export const BIOMETRIC_CONSENT_ERROR_CODE = 'BIOMETRIC_CONSENT_STALE';
export const BIOMETRIC_CONSENT_ERROR_MESSAGE = 'Confirm biometric consent again before enrolling a face; the acknowledgement must be recent.';

export type BiometricConsentStart = { monotonicMs: number; wallMs: number };

/** Wall elapsed time covers sleep on platforms whose monotonic clock pauses. */
export function biometricConsentAgeMs(start: BiometricConsentStart): number {
  const monotonicElapsed = performance.now() - start.monotonicMs;
  const wallElapsed = Date.now() - start.wallMs;
  return Math.ceil(wallElapsed < 0 ? monotonicElapsed : Math.max(monotonicElapsed, wallElapsed));
}

/** The page reports whole elapsed milliseconds since acknowledgement. */
export function isRecentBiometricConsentAge(ageMs: unknown): ageMs is number {
  return typeof ageMs === 'number' && Number.isFinite(ageMs) && Number.isInteger(ageMs)
    && ageMs >= 0 && ageMs <= BIOMETRIC_CONSENT_MAX_AGE_MS;
}

/** Server-derived acknowledgement time, allowing one minute of server clock skew. */
export function isRecentBiometricConsent(consentAt: unknown, now = Date.now()): consentAt is string {
  if (typeof consentAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:?\d{2})$/i.test(consentAt)) return false;
  const age = now - Date.parse(consentAt);
  return Number.isFinite(age) && age >= -60_000 && age <= BIOMETRIC_CONSENT_MAX_AGE_MS;
}
