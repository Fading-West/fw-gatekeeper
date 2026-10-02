// Preserve uncertain actions across retries and reloads in this tab. Clearing
// the ID requires an acknowledged response; a changed intent gets its own ID.
const pending = new Map<string, string>();
const prefix = 'gatekeeper:closeout-request:';
export function closeoutRequestId(payload: object): string {
  const key = prefix + JSON.stringify(payload);
  let id = pending.get(key);
  try { id ||= sessionStorage.getItem(key) || undefined; } catch { /* Tab storage may be disabled. */ }
  id ||= crypto.randomUUID();
  pending.set(key, id);
  try { sessionStorage.setItem(key, id); } catch { /* In-memory retries remain available. */ }
  return id;
}
export function acknowledgeCloseoutRequest(payload: object): void {
  const key = prefix + JSON.stringify(payload);
  pending.delete(key);
  try { sessionStorage.removeItem(key); } catch { /* Tab storage may be disabled. */ }
}
