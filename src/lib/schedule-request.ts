type ScheduleReceipt = { requestId: string; savedId?: string };
const observedCompletions = new Map<string, string>();
const prefix = 'gatekeeper:schedule-create:v2:';
const keyFor = (actorId: string, payload: object) => prefix + JSON.stringify([actorId, payload]);

function readReceipt(key: string): ScheduleReceipt | null {
  const value = sessionStorage.getItem(key);
  if (value === null) return null;
  // Preserve actor-scoped pending IDs written by the previous implementation.
  if (!value.startsWith('{')) return { requestId: value };
  const receipt = JSON.parse(value) as ScheduleReceipt;
  if (typeof receipt.requestId !== 'string' || !receipt.requestId ||
      (receipt.savedId !== undefined && (typeof receipt.savedId !== 'string' || !receipt.savedId))) {
    throw new Error('Invalid creation receipt');
  }
  return receipt;
}

export function prepareScheduleRequest(actorId: string, payload: object): ScheduleReceipt {
  const key = keyFor(actorId, payload);
  try {
    const receipt = readReceipt(key);
    // A freshly mounted page first shows a known completion without another
    // HTTP write. The next explicit New form may create an identical schedule.
    if (receipt?.savedId && observedCompletions.get(key) !== receipt.requestId) return receipt;
    const requestId = receipt && !receipt.savedId ? receipt.requestId : crypto.randomUUID();
    const pending = { requestId };
    const value = JSON.stringify(pending);
    sessionStorage.setItem(key, value);
    if (sessionStorage.getItem(key) !== value) throw new Error('Creation receipt was not stored');
    return pending;
  } catch {
    throw new Error('Unable to preserve the schedule creation receipt in this tab. Restore browser storage before retrying; no new request was sent.');
  }
}

export function observeScheduleCompletion(actorId: string, payload: object, requestId: string) {
  observedCompletions.set(keyFor(actorId, payload), requestId);
}

export function acknowledgeScheduleRequest(actorId: string, payload: object, requestId: string, savedId: string) {
  const key = keyFor(actorId, payload);
  try {
    if (readReceipt(key)?.requestId !== requestId) return false;
    // Never remove the original ID. Atomic replacement leaves either the
    // pending original or its completed marker, including on compound faults.
    const value = JSON.stringify({ requestId, savedId });
    sessionStorage.setItem(key, value);
    if (sessionStorage.getItem(key) !== value) throw new Error('Completion receipt was not stored');
  } catch {
    throw new Error('Schedule save was confirmed, but its completion receipt could not be verified. Keep this unchanged form to recover the original saved schedule after restoring browser storage.');
  }
  return true;
}
