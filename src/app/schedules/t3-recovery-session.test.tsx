import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ role: 'admin', actor: 'synthetic-admin' }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => state.role }));
vi.mock('@/hooks/useScheduleActor', () => ({ useScheduleActor: () => state.actor }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
import SchedulesPage from './page';
let tree: ReactTestRenderer | undefined;
const label = (node: any): string => typeof node === 'string' ? node : (node?.children || []).map(label).join('');
const saved = { id: 'one', name: 'Original', days: '[1]', start_time: '06:00', end_time: '14:30', active: 1, revision: 0 };
afterEach(async () => { if (tree) await act(async () => tree!.unmount()); vi.unstubAllGlobals(); state.role = 'admin'; state.actor = 'synthetic-admin'; });
it.each(['new-editor', 'role-regrant', 'actor-switch'])('ignores late conflict recovery after %s', async transition => {
  let resolve!: (value: Response) => void; let recovering = false;
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') return Promise.resolve(Response.json({ error: 'Changed' }, { status: 409 }));
    if (url === '/api/workers') return Promise.resolve(Response.json([]));
    if (recovering) return new Promise<Response>(done => { resolve = done; });
    return Promise.resolve(Response.json([saved]));
  }));
  await act(async () => { tree = create(<SchedulesPage />); });
  const button = (text: string) => tree!.root.findAllByType('button').find(node => label(node).trim() === text)!;
  await act(async () => tree!.root.findAllByType('button').find(node => node.props.className === 'btn-ghost text-xs')!.props.onClick());
  await act(async () => button('Update Schedule').props.onClick());
  recovering = true; let pending!: Promise<void>;
  await act(async () => { pending = button('Load current schedule').props.onClick(); });
  if (transition === 'role-regrant') {
    state.role = 'viewer'; await act(async () => tree!.update(<SchedulesPage />));
    state.role = 'admin'; await act(async () => tree!.update(<SchedulesPage />));
  } else if (transition === 'actor-switch') {
    state.actor = 'synthetic-other-admin'; await act(async () => tree!.update(<SchedulesPage />));
  } else await act(async () => button('Cancel').props.onClick());
  await act(async () => button('New Schedule').props.onClick());
  const name = () => tree!.root.findAllByType('input').find(node => node.props.placeholder === 'e.g. Default Mon-Fri')!;
  await act(async () => name().props.onChange({ target: { value: 'Fresh draft' } }));
  await act(async () => { resolve(Response.json([{ ...saved, name: 'Server current', revision: 1 }])); await pending; });
  expect(name().props.value).toBe('Fresh draft');
  expect(button('Create Schedule')).toBeTruthy();
});
