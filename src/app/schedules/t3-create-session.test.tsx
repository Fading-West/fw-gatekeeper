import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'admin' }));
vi.mock('@/hooks/useScheduleActor', () => ({ useScheduleActor: () => 'synthetic-admin' }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
import SchedulesPage from './page';
let tree: ReactTestRenderer | undefined;
const label = (node: any): string => typeof node === 'string' ? node : (node?.children || []).map(label).join('');
afterEach(async () => { if (tree) await act(async () => tree!.unmount()); vi.unstubAllGlobals(); });
it('does not erase a newly opened draft when an earlier creation finishes', async () => {
  let resolve!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => init?.method === 'POST'
    ? new Promise<Response>(done => { resolve = done; }) : Promise.resolve(Response.json([]))));
  await act(async () => { tree = create(<SchedulesPage />); });
  const button = (text: string) => tree!.root.findAllByType('button').find(node => label(node) === text)!;
  const name = () => tree!.root.findAllByType('input').find(node => node.props.placeholder === 'e.g. Default Mon-Fri')!;
  await act(async () => button('New Schedule').props.onClick());
  await act(async () => name().props.onChange({ target: { value: 'First draft' } }));
  let pending!: Promise<void>;
  await act(async () => { pending = button('Create Schedule').props.onClick(); });
  expect(name().props.disabled).toBe(true);
  await act(async () => button('Cancel').props.onClick());
  await act(async () => button('New Schedule').props.onClick());
  await act(async () => { resolve(Response.json({ id: 'saved-first' })); await pending; });
  expect(name().props.value).toBe('');
  expect(button('Create Schedule')).toBeTruthy();
  await act(async () => name().props.onChange({ target: { value: 'New draft' } }));
  expect(name().props.value).toBe('New draft');
});
