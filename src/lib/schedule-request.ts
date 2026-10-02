const pending = new Map<string, string>();
const prefix = 'gatekeeper:schedule-create:v2:';
const keyFor = (actorId: string, payload: object) => prefix + JSON.stringify([actorId, payload]);

export function scheduleRequestId(actorId: string, payload: object) {
  const key = keyFor(actorId, payload);
  let id = pending.get(key);
  try { id ||= sessionStorage.getItem(key) || undefined; } catch { /* Use memory when storage is blocked. */ }
  id ||= crypto.randomUUID();
  pending.set(key, id);
  try { sessionStorage.setItem(key, id); } catch { /* The same mounted flow can still retry. */ }
  return id;
}

export function acknowledgeScheduleRequest(actorId: string, payload: object, requestId: string) {
  const key = keyFor(actorId, payload);
  const memoryId = pending.get(key);
  if (memoryId !== undefined && memoryId !== requestId) return;
  try {
    const storedId = sessionStorage.getItem(key);
    if (storedId !== null && storedId !== requestId) return;
    if (memoryId === undefined && storedId !== requestId) return;
  } catch { if (memoryId !== requestId) return; }
  pending.delete(key);
  try { sessionStorage.removeItem(key); } catch { /* Storage is optional. */ }
}
