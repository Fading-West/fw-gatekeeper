// Keep uncertain requests across modal closes and page reloads in this tab.
// A changed payload gets a new ID; only an acknowledged save clears its ID.
const pending = new Map<string, string>();
const prefix = 'gatekeeper:correction-request:';

export function correctionRequestId(payload: object): string {
  const key = prefix + JSON.stringify(payload);
  let requestId = pending.get(key);
  try { requestId ||= sessionStorage.getItem(key) || undefined; } catch { /* Storage may be disabled. */ }
  requestId ||= crypto.randomUUID();
  pending.set(key, requestId);
  try { sessionStorage.setItem(key, requestId); } catch { /* Retain the in-memory retry ID. */ }
  return requestId;
}

export function acknowledgeCorrectionRequest(payload: object): void {
  const key = prefix + JSON.stringify(payload);
  pending.delete(key);
  try { sessionStorage.removeItem(key); } catch { /* Storage may be disabled. */ }
}
