const pending = new Map<string, string>();
const prefix = 'gatekeeper:schedule-create:v2:';
const keyFor = (actorId: string, payload: object) => prefix + JSON.stringify([actorId, payload]);

export function scheduleRequestId(actorId: string, payload: object) {
  const key = keyFor(actorId, payload);
  let id: string;
  try {
    const storedId = sessionStorage.getItem(key);
    const memoryId = pending.get(key);
    if (storedId && memoryId && storedId !== memoryId) throw new Error('Creation receipt changed');
    id = memoryId || storedId || crypto.randomUUID();
    sessionStorage.setItem(key, id);
    if (sessionStorage.getItem(key) !== id) throw new Error('Creation receipt was not stored');
  } catch {
    throw new Error('Unable to preserve the schedule creation receipt in this tab. Restore browser storage before retrying; no new request was sent.');
  }
  pending.set(key, id);
  return id;
}

export function acknowledgeScheduleRequest(actorId: string, payload: object, requestId: string) {
  const key = keyFor(actorId, payload);
  const memoryId = pending.get(key);
  if (memoryId !== undefined && memoryId !== requestId) return false;
  let matched = false;
  try {
    const storedId = sessionStorage.getItem(key);
    if (storedId !== requestId) return false;
    matched = true;
    sessionStorage.removeItem(key);
    if (sessionStorage.getItem(key) !== null) throw new Error('Creation receipt was not cleared');
  } catch {
    // A failed or unconfirmed removal must not turn a retry into a new intent.
    // Keep memory and restore the durable ID if removal happened before failure.
    if (matched) {
      try { sessionStorage.setItem(key, requestId); } catch { /* Keep the original in-memory intent for recovery. */ }
    }
    throw new Error('Schedule save was confirmed, but its receipt could not be cleared. Keep this unchanged form and retry after restoring browser storage.');
  }
  pending.delete(key);
  return true;
}
