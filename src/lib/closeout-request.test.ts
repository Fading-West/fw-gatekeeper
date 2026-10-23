import { beforeEach, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();
beforeEach(() => {
  vi.resetModules(); storage.clear();
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
});
const intent = { date: '2026-09-03', action: 'complete' as const, expected_revision: null, supervisor_name: 'Synthetic supervisor', notes: 'Original signed intent', acknowledged_blockers: true, blocker_evidence: 'original sources' };
it('restores the full original action after module reload and isolates other actors/dates', async () => {
  const first = await import('./closeout-request');
  const editableIntent = { ...intent };
  const action = first.beginCloseoutAction('synthetic-actor', editableIntent);
  editableIntent.notes = 'Changed editable form';
  vi.resetModules();
  const restored = await import('./closeout-request');
  expect(restored.loadCloseoutAction('synthetic-actor', intent.date)).toEqual(action);
  expect(restored.loadCloseoutAction('another-actor', intent.date)).toBeNull();
  expect(restored.loadCloseoutAction('synthetic-actor', '2026-09-04')).toBeNull();
  expect(() => restored.beginCloseoutAction('synthetic-actor', intent)).toThrow('Resolve the saved action');
});
it('retains uncertain actions until actor/request/status/revision receipt validation passes', async () => {
  const helper = await import('./closeout-request');
  const action = helper.beginCloseoutAction('synthetic-actor', intent);
  const receipt = { id: 'synthetic-closeout', status: 'completed', revision: 1, requestId: action.requestId, actorUserId: action.actorId };
  for (const invalid of [{}, null, { ...receipt, requestId: 'other' }, { ...receipt, actorUserId: 'other' }, { ...receipt, status: 'reopened' }, { ...receipt, revision: 0 }, { ...receipt, revision: 1.5 }]) {
    expect(helper.acknowledgeCloseoutAction(action, invalid)).toBe(false);
    expect(helper.loadCloseoutAction(action.actorId, intent.date)).toEqual(action);
  }
  expect(() => helper.reconcileRejectedCloseoutAction(action)).toThrow('uncertain action');
  expect(helper.acknowledgeCloseoutAction(action, receipt)).toBe(true);
  expect(helper.loadCloseoutAction(action.actorId, intent.date)).toBeNull();
});
it('restores an explicit rejection and clears it only through deliberate reconciliation', async () => {
  const helper = await import('./closeout-request');
  const action = helper.rejectCloseoutAction(helper.beginCloseoutAction('synthetic-actor', intent));
  vi.resetModules();
  const reloaded = await import('./closeout-request');
  expect(reloaded.loadCloseoutAction(action.actorId, intent.date)).toEqual(action);
  reloaded.reconcileRejectedCloseoutAction(action);
  expect(reloaded.loadCloseoutAction(action.actorId, intent.date)).toBeNull();
});
it('keeps a confirmed action cleared in memory when tab storage cannot remove its stale value', async () => {
  const helper = await import('./closeout-request');
  const action = helper.beginCloseoutAction('synthetic-remove-failure', intent);
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: () => { throw new Error('Storage unavailable'); } });
  expect(helper.acknowledgeCloseoutAction(action, { id: 'synthetic-closeout', status: 'completed', revision: 1, requestId: action.requestId, actorUserId: action.actorId })).toBe(true);
  expect(helper.loadCloseoutAction(action.actorId, intent.date)).toBeNull();
  expect(helper.beginCloseoutAction(action.actorId, intent).requestId).not.toBe(action.requestId);
});
