/** Existing string field: legacy single reasons or comma-separated faults. */
export function getKioskDegradedReasons(reason?: string | null): string[] {
  return [...new Set((reason ?? '').split(',').map(value => value.trim()).filter(Boolean))];
}
