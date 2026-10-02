/// <reference types="vite/client" />
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { convexTest } from 'convex-test';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../../convex/_generated/api';
import schema from '../../../convex/schema';

const session = vi.hoisted(() => ({ actor: undefined as string | undefined, toast: vi.fn() }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'admin' }));
vi.mock('@/hooks/useScheduleActor', () => ({ useScheduleActor: () => session.actor }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: session.toast }) }));
import SchedulesPage from './page';

const modules = import.meta.glob('../../../convex/**/*.ts');
let tree: ReactTestRenderer | undefined;
afterEach(async () => {
  if (tree) await act(async () => tree!.unmount());
  tree = undefined;
  session.actor = undefined;
  session.toast.mockClear();
  vi.unstubAllGlobals();
});
const label = (node: ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(label).join('');
const button = (text: string) => tree!.root.findAllByType('button').find(node => label(node) === text)!;
async function openDraft() {
  await act(async () => button('New Schedule').props.onClick());
  await act(async () => tree!.root.findAllByType('input').find(node =>
    node.props.placeholder === 'e.g. Default Mon-Fri')!.props.onChange({ target: { value: 'Synthetic shared schedule' } }));
}
const storageAdapter = (storage: Map<string, string>) => ({
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
  removeItem: (key: string) => { storage.delete(key); },
});
const receipts = (storage: Map<string, string>) => [...storage.values()].map(value =>
  JSON.parse(value) as { requestId: string; savedId?: string });
const pendingReceipts = (storage: Map<string, string>) => receipts(storage).filter(receipt => !receipt.savedId);

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async ctx => {
    const result = [];
    for (const name of ['A', 'B']) {
      const id = await ctx.db.insert('users', { email: `synthetic-${name}@example.invalid` });
      await ctx.db.insert('portalMembers', { userId: id, role: 'admin', active: true, createdAt: '2026-10-02' });
      result.push(id);
    }
    return result;
  });
  const storage = new Map<string, string>();
  vi.stubGlobal('sessionStorage', storageAdapter(storage));
  session.actor = String(ids[0]);
  const calls: { actor: string; requestId: string; id: string }[] = [];
  const commit = async (init: RequestInit) => {
    // Capture the HTTP request's actor before any asynchronous work, then run
    // the real receipt mutation rather than implementing deduplication here.
    const actor = session.actor;
    if (!actor) throw new Error('Synthetic transport requires a signed-in actor');
    const body = JSON.parse(init.body as string);
    const result = await t.withIdentity({ subject: actor }).mutation(api.schedules.create, {
      requestId: body.request_id, name: body.name, days: JSON.stringify(body.days),
      startTime: body.start_time, endTime: body.end_time, department: body.department || undefined,
    });
    calls.push({ actor, requestId: body.request_id, id: String(result.id) });
    return result;
  };
  const rows = () => t.run(ctx => ctx.db.query('schedules').collect());
  return { ids, storage, calls, commit, rows };
}

it('keeps admin A’s lost receipt through admin B’s identical save and replays A without a third insertion', async () => {
  const { ids, storage, calls, commit, rows } = await setup();
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return Response.json([]);
    const result = await commit(init);
    if (calls.length === 1) throw new Error('Synthetic response lost after commit');
    return Response.json(result);
  }));
  await act(async () => { tree = create(<SchedulesPage />); });
  await openDraft();
  await act(async () => button('Create Schedule').props.onClick());
  expect(await rows()).toHaveLength(1);
  expect(storage.size).toBe(1);

  session.actor = String(ids[1]);
  await act(async () => tree!.update(<SchedulesPage />));
  await openDraft();
  await act(async () => button('Create Schedule').props.onClick());
  expect(calls[1].actor).not.toBe(calls[0].actor);
  expect(calls[1].requestId).not.toBe(calls[0].requestId);
  expect(await rows()).toHaveLength(2);
  expect(pendingReceipts(storage).map(receipt => receipt.requestId)).toEqual([calls[0].requestId]);

  session.actor = String(ids[0]);
  await act(async () => tree!.update(<SchedulesPage />));
  await openDraft();
  await act(async () => button('Create Schedule').props.onClick());
  expect(calls[2]).toEqual(calls[0]);
  expect(await rows()).toHaveLength(2);
  expect(pendingReceipts(storage)).toHaveLength(0);
});

it('does not let a late response from an unmounted form erase a newer identical creation receipt', async () => {
  const { storage, calls, commit, rows } = await setup();
  let releaseOld!: (response: Response) => void;
  let markCommitted!: () => void;
  const oldCommitted = new Promise<void>(done => { markCommitted = done; });
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return Response.json([]);
    const result = await commit(init);
    if (calls.length === 1) {
      const delayed = new Promise<Response>(done => { releaseOld = done; });
      markCommitted();
      return delayed;
    }
    if (calls.length === 3) throw new Error('Synthetic newer response lost after commit');
    return Response.json(result);
  }));
  await act(async () => { tree = create(<SchedulesPage />); });
  await openDraft();
  let oldRequest!: Promise<void>;
  await act(async () => { oldRequest = button('Create Schedule').props.onClick(); await oldCommitted; });
  await act(async () => tree!.unmount());
  await act(async () => { tree = create(<SchedulesPage />); });
  await openDraft();
  await act(async () => button('Create Schedule').props.onClick());
  expect(calls[1]).toEqual(calls[0]);
  expect(pendingReceipts(storage)).toHaveLength(0);

  await openDraft();
  await act(async () => button('Create Schedule').props.onClick());
  expect(calls[2].requestId).not.toBe(calls[0].requestId);
  expect(storage.size).toBe(1);
  await act(async () => { releaseOld(Response.json({ id: calls[0].id })); await oldRequest; });
  expect(storage.size).toBe(1);
  await act(async () => button('Create Schedule').props.onClick());
  expect(calls[3]).toEqual(calls[2]);
  expect(await rows()).toHaveLength(2);
  expect(pendingReceipts(storage)).toHaveLength(0);
});

it.each(['get', 'set', 'silent-set', 'readback'] as const)('sends no creation before or after remount when receipt storage fails at %s', async fault => {
  const { storage, calls, commit, rows } = await setup();
  const adapter = storageAdapter(storage);
  let reads = 0;
  vi.stubGlobal('sessionStorage', {
    ...adapter,
    getItem: (key: string) => {
      if (fault === 'get') throw new Error('Synthetic blocked reads');
      reads += 1;
      if (fault === 'readback' && reads % 2 === 0) return null;
      return adapter.getItem(key);
    },
    setItem: (key: string, value: string) => {
      if (fault === 'set') throw new Error('Synthetic blocked writes');
      if (fault !== 'silent-set') adapter.setItem(key, value);
    },
  });
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === 'POST' ? Response.json(await commit(init)) : Response.json([])));
  await act(async () => { tree = create(<SchedulesPage />); });
  await openDraft();
  await act(async () => button('Create Schedule').props.onClick());
  expect(calls).toHaveLength(0);
  expect(await rows()).toHaveLength(0);
  expect(tree!.root.findAllByType('input').some(node => node.props.value === 'Synthetic shared schedule')).toBe(true);
  await act(async () => tree!.unmount());
  await act(async () => { tree = create(<SchedulesPage />); });
  await openDraft();
  await act(async () => button('Create Schedule').props.onClick());
  expect(calls).toHaveLength(0);
  expect(await rows()).toHaveLength(0);
});

it.each(['completion-write', 'silent-completion-write', 'completion-readback'] as const)('retains the confirmed original ID and unchanged form after %s failure', async fault => {
  const { storage, calls, commit, rows } = await setup();
  const adapter = storageAdapter(storage);
  let failRead = false;
  vi.stubGlobal('sessionStorage', {
    ...adapter,
    getItem: (key: string) => {
      if (failRead) { failRead = false; throw new Error('Synthetic unconfirmed removal'); }
      return adapter.getItem(key);
    },
    setItem: (key: string, value: string) => {
      if (!JSON.parse(value).savedId) { adapter.setItem(key, value); return; }
      if (fault === 'completion-write') throw new Error('Synthetic blocked completion write');
      if (fault === 'silent-completion-write') return;
      adapter.setItem(key, value);
      failRead = true;
    },
    removeItem: () => { throw new Error('Receipts must never be destructively removed'); },
  });
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === 'POST' ? Response.json(await commit(init)) : Response.json([])));
  await act(async () => { tree = create(<SchedulesPage />); });
  await openDraft();
  await act(async () => button('Create Schedule').props.onClick());
  expect(await rows()).toHaveLength(1);
  expect(receipts(storage).map(receipt => receipt.requestId)).toEqual([calls[0].requestId]);
  expect(tree!.root.findAllByType('input').some(node => node.props.value === 'Synthetic shared schedule')).toBe(true);
  expect(button('Create Schedule').props.disabled).toBe(false);
  vi.stubGlobal('sessionStorage', adapter);
  await act(async () => button('Create Schedule').props.onClick());
  if (fault === 'completion-readback') expect(calls).toHaveLength(1);
  else expect(calls[1]).toEqual(calls[0]);
  expect(await rows()).toHaveLength(1);
  expect(pendingReceipts(storage)).toHaveLength(0);
});

it('retires a hung actor’s flight without allowing its late completion to release the new actor’s pending save', async () => {
  const { ids, storage, calls, commit, rows } = await setup();
  const releases: ((response: Response) => void)[] = [];
  const committed: (() => void)[] = [];
  const barriers = [0, 1].map(index => new Promise<void>(done => { committed[index] = done; }));
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return Response.json([]);
    await commit(init);
    const index = calls.length - 1;
    const delayed = new Promise<Response>(done => { releases[index] = done; });
    committed[index]();
    return delayed;
  }));
  await act(async () => { tree = create(<SchedulesPage />); });
  await openDraft();
  let oldRequest!: Promise<void>;
  await act(async () => { oldRequest = button('Create Schedule').props.onClick(); await barriers[0]; });
  session.actor = String(ids[1]);
  await act(async () => tree!.update(<SchedulesPage />));
  await openDraft();
  expect(button('Create Schedule').props.disabled).toBe(false);
  let newRequest!: Promise<void>;
  await act(async () => { newRequest = button('Create Schedule').props.onClick(); await barriers[1]; });
  expect(storage.size).toBe(2);
  await act(async () => { releases[0](Response.json({ id: calls[0].id })); await oldRequest; });
  expect(pendingReceipts(storage).map(receipt => receipt.requestId)).toEqual([calls[1].requestId]);
  expect(button('Create Schedule').props.disabled).toBe(true);
  await act(async () => button('Create Schedule').props.onClick());
  expect(calls).toHaveLength(2);
  await act(async () => { releases[1](Response.json({ id: calls[1].id })); await newRequest; });
  expect(await rows()).toHaveLength(2);
  expect(pendingReceipts(storage)).toHaveLength(0);
});

it.each(['blocked-followup-write', 'silent-followup-write', 'silent-completion-write'] as const)('keeps the original durable ID across compound %s and a full module/page reload', async fault => {
  const { storage, calls, commit, rows } = await setup();
  const adapter = storageAdapter(storage);
  let completionAttempted = false;
  let failRead = false;
  let faultsActive = true;
  const remove = vi.fn(() => { throw new Error('Destructive receipt removal is forbidden'); });
  vi.stubGlobal('sessionStorage', {
    ...adapter,
    getItem: (key: string) => {
      if (failRead) { failRead = false; throw new Error('Synthetic completion readback failed'); }
      return adapter.getItem(key);
    },
    setItem: (key: string, value: string) => {
      if (!faultsActive) { adapter.setItem(key, value); return; }
      if (completionAttempted) {
        if (fault === 'blocked-followup-write') throw new Error('Synthetic followup write blocked');
        return; // Simulate silent loss of any attempted restoration/write.
      }
      if (JSON.parse(value).savedId) {
        completionAttempted = true;
        if (fault !== 'silent-completion-write') adapter.setItem(key, value);
        failRead = true;
        return;
      }
      adapter.setItem(key, value);
    },
    removeItem: remove,
  });
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === 'POST' ? Response.json(await commit(init)) : Response.json([])));
  await act(async () => { tree = create(<SchedulesPage />); });
  await openDraft();
  await act(async () => button('Create Schedule').props.onClick());
  const original = calls[0];
  expect(receipts(storage).map(receipt => receipt.requestId)).toEqual([original.requestId]);
  expect(session.toast.mock.calls.some(([message]) => message.includes('Schedule save was confirmed'))).toBe(true);
  await act(async () => tree!.unmount());
  // Clear the helper's memory as a real page reload does, while keeping the
  // same tab's durable storage and the independently committed database.
  vi.resetModules();
  const ReloadedSchedulesPage = (await import('./page')).default;
  await act(async () => { tree = create(<ReloadedSchedulesPage />); });
  await openDraft();
  await act(async () => button('Create Schedule').props.onClick());
  if (fault === 'silent-completion-write') {
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(original);
  } else expect(calls).toHaveLength(1);
  expect(await rows()).toHaveLength(1);
  expect(receipts(storage).map(receipt => receipt.requestId)).toEqual([original.requestId]);
  expect(remove).not.toHaveBeenCalled();
  if (fault !== 'silent-completion-write') {
    expect(session.toast.mock.calls.some(([message]) => message.includes('original save is confirmed'))).toBe(true);
  }

  faultsActive = false;
  if (fault === 'silent-completion-write') {
    await act(async () => button('Create Schedule').props.onClick());
    expect(calls[1]).toEqual(original);
    expect(await rows()).toHaveLength(1);
  }
  // After observing the confirmed outcome, explicit New remains a distinct,
  // intentional creation even when every schedule field is identical.
  await openDraft();
  await act(async () => button('Create Schedule').props.onClick());
  expect(calls.at(-1)?.requestId).not.toBe(original.requestId);
  expect(await rows()).toHaveLength(2);
});
