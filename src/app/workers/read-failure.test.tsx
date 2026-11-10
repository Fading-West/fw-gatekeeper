import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'admin' }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
import WorkersPage from './page';

let tree: ReactTestRenderer | undefined;
const label = (node: any): string => typeof node === 'string' ? node : (node?.children || []).map(label).join('');
const text = () => label(tree!.toJSON());
afterEach(async () => {
  if (tree) await act(async () => tree!.unmount());
  tree = undefined;
  vi.unstubAllGlobals();
});

it.each([false, true])('does not claim zero workers or retained face data after a failed roster read (inactive=%s)', async inactive => {
  let failed = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/kiosks') return Response.json([]);
    return failed ? Response.json({ error: 'Unavailable' }, { status: 503 }) : Response.json([{
      id: 'synthetic', name: 'Synthetic worker', employee_id: 'S-1', department: 'Synthetic',
      active: inactive ? 0 : 1, encoding_status: 'valid', has_face_encoding: true,
    }]);
  }));
  await act(async () => { tree = create(<WorkersPage />); });
  if (inactive) await act(async () => tree!.root.findByProps({ type: 'checkbox' }).props.onChange({ target: { checked: true } }));
  expect(tree!.root.findByProps({ role: 'alert' }).children.join('')).toContain('Failed to load workers');
  expect(text()).not.toContain('0 registered workers');
  expect(text()).not.toContain('0 inactive workers');
  expect(text()).not.toContain('No workers match these filters');
  expect(text()).not.toContain('No workers registered yet');
  expect(text()).toContain('Worker counts unavailable');
  failed = false;
  const retry = tree!.root.findAllByType('button').find(node => label(node) === 'Retry loading workers');
  expect(retry).toBeDefined();
  await act(async () => retry!.props.onClick());
  expect(text()).toContain(inactive ? '1 inactive workers · 1 with retained face data' : '1 registered workers · 1 face enrolled');
  expect(text()).not.toContain('Worker counts unavailable');
  expect(tree!.root.findAllByProps({ role: 'alert' })).toHaveLength(0);
});

it('still distinguishes a successful empty roster from a failed read', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json([])));
  await act(async () => { tree = create(<WorkersPage />); });
  expect(text()).toContain('0 registered workers');
  expect(text()).toContain('No workers registered yet');
  expect(text()).not.toContain('Worker counts unavailable');
});
