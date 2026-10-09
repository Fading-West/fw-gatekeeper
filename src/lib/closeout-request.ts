export type CloseoutIntent = {
  date: string;
  action: 'save' | 'complete' | 'reopen';
  expected_revision: number | null;
  supervisor_name: string;
  notes: string;
  acknowledged_blockers: boolean;
  blocker_evidence?: string;
};
export type PendingCloseoutAction = {
  actorId: string;
  requestId: string;
  intent: CloseoutIntent;
  rejected: boolean;
};
const pending = new Map<string, PendingCloseoutAction>();
const cleared = new Set<string>();
const prefix = 'gatekeeper:closeout-intent:v1:';
const keyFor = (actor: string, date: string) => prefix + JSON.stringify([actor, date]);
function valid(value: unknown, actor: string, date: string): value is PendingCloseoutAction {
  if (!value || typeof value !== 'object') return false;
  const action = value as PendingCloseoutAction;
  const intent = action.intent;
  return action.actorId === actor && typeof action.requestId === 'string' && !!action.requestId &&
    typeof action.rejected === 'boolean' && !!intent && intent.date === date &&
    ['save', 'complete', 'reopen'].includes(intent.action) &&
    (intent.expected_revision === null || (Number.isSafeInteger(intent.expected_revision) && intent.expected_revision >= 0)) &&
    typeof intent.supervisor_name === 'string' && typeof intent.notes === 'string' &&
    typeof intent.acknowledged_blockers === 'boolean' &&
    (intent.blocker_evidence === undefined || typeof intent.blocker_evidence === 'string');
}
const copy = (action: PendingCloseoutAction): PendingCloseoutAction => ({ ...action, intent: { ...action.intent } });
function persist(action: PendingCloseoutAction) {
  const key = keyFor(action.actorId, action.intent.date);
  cleared.delete(key);
  pending.set(key, copy(action));
  try { sessionStorage.setItem(key, JSON.stringify(action)); } catch { /* The current page still retains the complete intent. */ }
}
export function loadCloseoutAction(actor: string, date: string): PendingCloseoutAction | null {
  const key = keyFor(actor, date);
  if (cleared.has(key)) return null;
  let action = pending.get(key);
  if (!action) {
    try {
      const stored: unknown = JSON.parse(sessionStorage.getItem(key) || 'null');
      if (valid(stored, actor, date)) { action = stored; pending.set(key, copy(stored)); }
    } catch { /* Invalid or disabled tab storage cannot supply an action. */ }
  }
  return action ? copy(action) : null;
}
export function beginCloseoutAction(actor: string, intent: CloseoutIntent): PendingCloseoutAction {
  if (loadCloseoutAction(actor, intent.date)) throw new Error('Resolve the saved action before starting another action for this shift.');
  const action = { actorId: actor, requestId: crypto.randomUUID(), intent: { ...intent }, rejected: false };
  persist(action);
  return copy(action);
}
export function rejectCloseoutAction(action: PendingCloseoutAction): PendingCloseoutAction {
  const rejected = { ...action, rejected: true };
  persist(rejected);
  return copy(rejected);
}
function clear(action: PendingCloseoutAction) {
  const key = keyFor(action.actorId, action.intent.date);
  if (loadCloseoutAction(action.actorId, action.intent.date)?.requestId !== action.requestId) return;
  pending.delete(key);
  cleared.add(key);
  try { sessionStorage.removeItem(key); } catch { /* In-memory acknowledgement remains available. */ }
}
export function acknowledgeCloseoutAction(action: PendingCloseoutAction, receipt: unknown): boolean {
  if (!receipt || typeof receipt !== 'object') return false;
  const result = receipt as Record<string, unknown>;
  const expectedStatus = action.intent.action === 'complete' ? ['completed'] : action.intent.action === 'reopen' ? ['reopened'] : ['open', 'reopened'];
  if (result.requestId !== action.requestId || result.actorUserId !== action.actorId ||
      typeof result.id !== 'string' || !result.id || !expectedStatus.includes(String(result.status)) ||
      typeof result.revision !== 'number' || !Number.isSafeInteger(result.revision) || result.revision < 0 ||
      result.revision < (action.intent.expected_revision ?? 0) ||
      (result.revision === (action.intent.expected_revision ?? 0) && (action.intent.action !== 'complete' || action.intent.expected_revision === null))) return false;
  clear(action);
  return true;
}
export function closeoutActionStored(action: PendingCloseoutAction): boolean {
  try { return sessionStorage.getItem(keyFor(action.actorId, action.intent.date)) === JSON.stringify(action); } catch { return false; }
}
export function reconcileRejectedCloseoutAction(action: PendingCloseoutAction): void {
  if (!action.rejected) throw new Error('An uncertain action must be retried to recover its receipt.');
  clear(action);
}
