// Kiosk queue counts decide whether attendance evidence is complete, so a
// malformed report must stay unknown instead of becoming a healthy zero.
const CANONICAL_COUNT = /^(?:0|[1-9][0-9]*)$/;

export function parseQueueCount(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value !== 'string' || !CANONICAL_COUNT.test(value)) return undefined;
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : undefined;
}
