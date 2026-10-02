/// <reference types="vite/client" />
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { convexTest } from 'convex-test';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../../convex/_generated/api';
import schema from '../../../convex/schema';

const session = vi.hoisted(() => ({ actor: undefined as string | undefined }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'admin' }));
vi.mock('@/hooks/useScheduleActor', () => ({ useScheduleActor: () => session.actor }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
import SchedulesPage from './page';

const modules = import.meta.glob('../../../convex/**/*.ts');
let tree: ReactTestRenderer | undefined;
afterEach(async () => {
  if (tree) await act(async () => tree!.unmount());
  tree = undefined;
  session.actor = undefined;
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
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
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
  expect(storage.size).toBe(1); // A's uncertain receipt survives B's acknowledgement.

  session.actor = String(ids[0]);
  await act(async () => tree!.update(<SchedulesPage />));
  await openDraft();
  await act(async () => button('Create Schedule').props.onClick());
  expect(calls[2]).toEqual(calls[0]);
  expect(await rows()).toHaveLength(2);
  expect(storage.size).toBe(0);
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
  expect(storage.size).toBe(0);

  await openDraft();
  await act(async () => button('Create Schedule').props.onClick());
  expect(calls[2].requestId).not.toBe(calls[0].requestId);
  expect(storage.size).toBe(1);
  await act(async () => { releaseOld(Response.json({ id: calls[0].id })); await oldRequest; });
  expect(storage.size).toBe(1);
  await act(async () => button('Create Schedule').props.onClick());
  expect(calls[3]).toEqual(calls[2]);
  expect(await rows()).toHaveLength(2);
  expect(storage.size).toBe(0);
});
