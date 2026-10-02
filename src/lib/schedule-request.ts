const pending = new Map<string, string>();
const prefix = 'gatekeeper:schedule-create:';

export function scheduleRequestId(payload: object) {
  const key = prefix + JSON.stringify(payload);
  let id = pending.get(key);
  try { id ||= sessionStorage.getItem(key) || undefined; } catch { /* Use memory when storage is blocked. */ }
  id ||= crypto.randomUUID();
  pending.set(key, id);
  try { sessionStorage.setItem(key, id); } catch { /* The same mounted flow can still retry. */ }
  return id;
}

export function acknowledgeScheduleRequest(payload: object) {
  const key = prefix + JSON.stringify(payload);
  pending.delete(key);
  try { sessionStorage.removeItem(key); } catch { /* Storage is optional. */ }
}
