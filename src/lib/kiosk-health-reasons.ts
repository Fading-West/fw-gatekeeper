/** Existing string field: legacy single reasons or comma-separated faults. The
 * kiosk appends "; upload_quarantine: N attendance, M recognition" as one clause. */
export function getKioskDegradedReasons(reason?: string | null): string[] {
  const reasons = (reason ?? '').split(';').flatMap(clause =>
    clause.trim().startsWith('upload_quarantine:') ? [clause] : clause.split(','));
  return [...new Set(reasons.map(value => value.trim()).filter(Boolean))];
}
