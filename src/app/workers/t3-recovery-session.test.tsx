import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ role: 'admin' as string | undefined }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => state.role }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
import WorkersPage from './page';
const worker = { id: 'synthetic', name: 'Original', employee_id: 'S-1', department: 'Mill', active: 1, identity_revision: 'original' };
let tree: ReactTestRenderer | undefined;
const label = (node: any): string => typeof node === 'string' ? node : (node?.children || []).map(label).join('');
const button = (text: string) => tree!.root.findAllByType('button').find(node => label(node) === text)!;
const field = () => tree!.root.findAllByType('input').find(node => node.props.placeholder === 'e.g. John Smith')!;
afterEach(async () => { if (tree) await act(async () => tree!.unmount()); tree = undefined; state.role = 'admin'; vi.unstubAllGlobals(); });
it.each(['cancel', 'role'] as const)('retires recovery across a %s boundary, even after access is restored', async (boundary) => {
  let resolve!: (response: Response) => void;
  const recovery = new Promise<Response>(done => { resolve = done; });
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    if (options?.method === 'PATCH') return Promise.resolve(Response.json({ error: 'Changed' }, { status: 409 }));
    if (url.includes('?id=')) return recovery;
    return Promise.resolve(Response.json(url === '/api/kiosks' ? [] : [worker]));
  }));
  await act(async () => { tree = create(<WorkersPage />); });
  await act(async () => button('Edit').props.onClick());
  await act(async () => button('Save Changes').props.onClick());
  let pending!: Promise<void>;
  await act(async () => { pending = button('Load current record').props.onClick(); });
  if (boundary === 'cancel') await act(async () => button('Cancel').props.onClick());
  else {
    state.role = 'viewer'; await act(async () => tree!.update(<WorkersPage />));
    expect(tree!.root.findAllByType('input').some(node => node.props.placeholder === 'e.g. John Smith')).toBe(false);
    state.role = 'admin'; await act(async () => tree!.update(<WorkersPage />));
  }
  await act(async () => button('Edit').props.onClick());
  await act(async () => field().props.onChange({ target: { value: 'New draft' } }));
  await act(async () => { resolve(Response.json({ ...worker, name: 'Obsolete response', identity_revision: 'new' })); await pending; });
  expect(field().props.value).toBe('New draft');
});
