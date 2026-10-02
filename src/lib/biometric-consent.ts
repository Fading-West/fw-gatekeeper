/** Ten minute acknowledgement window, allowing one minute of clock skew. */
export function isRecentBiometricConsent(consentAt: unknown, now = Date.now()): consentAt is string {
  if (typeof consentAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:?\d{2})$/i.test(consentAt)) return false;
  const age = now - Date.parse(consentAt);
  return Number.isFinite(age) && age >= -60_000 && age <= 10 * 60_000;
}
