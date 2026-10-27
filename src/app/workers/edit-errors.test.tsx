import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'admin' }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
import WorkersPage from './page';
const worker = { id: 'synthetic', name: 'Original', employee_id: 'S-1', department: 'Mill', active: 1, identity_revision: 'original' };
let tree: ReactTestRenderer | undefined;
const label = (node: any): string => typeof node === 'string' ? node : (node?.children || []).map(label).join('');
const buttons = (text: string) => tree!.root.findAllByType('button').filter(node => label(node) === text);
const field = () => tree!.root.findAllByType('input').find(node => node.props.placeholder === 'e.g. John Smith')!;
afterEach(async () => { if (tree) await act(async () => tree!.unmount()); tree = undefined; toast.mockReset(); vi.unstubAllGlobals(); });

it.each([
  [409, 'Worker name already exists'],
  [409, 'Employee ID S-2 already belongs to Other Worker'],
  [400, 'Active worker not found; use enrollment to restore a worker by employee ID'],
])('shows why a %s worker edit was rejected and keeps the draft', async (status, error) => {
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    if (options?.method === 'PATCH') return Promise.resolve(Response.json({ error }, { status }));
    return Promise.resolve(Response.json(url === '/api/kiosks' ? [] : [worker]));
  }));
  await act(async () => { tree = create(<WorkersPage />); });
  await act(async () => buttons('Edit')[0].props.onClick());
  await act(async () => field().props.onChange({ target: { value: 'Draft name' } }));
  await act(async () => buttons('Save Changes')[0].props.onClick());
  expect(toast).toHaveBeenCalledWith(error, 'error');
  expect(buttons('Load current record')).toHaveLength(0);
  expect(field().props.value).toBe('Draft name');
});
