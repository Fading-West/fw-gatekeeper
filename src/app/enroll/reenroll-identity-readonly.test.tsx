import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
const page = vi.hoisted(() => ({ role: 'enrollment', search: 'worker_id=w1' }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }), useSearchParams: () => new URLSearchParams(page.search) }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => page.role }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
import EnrollPage from './page';
let tree: ReactTestRenderer | undefined;
const label = (node: any): string => typeof node === 'string' ? node : (node?.children || []).map(label).join('');
const identityInputs = () => ['e.g. F-2', 'e.g. Area Manager, Mill, Station 4'].map(placeholder => tree!.root.findByProps({ placeholder }));
async function render(role: string, search: string) {
  page.role = role;
  page.search = search;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.startsWith('/api/workers?id=')
    ? { name: 'Ana', employee_id: 'F-2', department: 'Mill', identity_revision: 'rev' }
    : { suggestions: [], summary: { total: 0, enrolled: 0, remaining: 0, invalid: 0 } })));
  await act(async () => { tree = create(<EnrollPage />); });
}
afterEach(async () => { if (tree) await act(async () => tree!.unmount()); tree = undefined; vi.unstubAllGlobals(); });

it('keeps employee ID and department read-only when the enrollment role re-enrolls a worker', async () => {
  await render('enrollment', 'worker_id=w1');
  expect(identityInputs().map(input => [input.props.value, input.props.readOnly])).toEqual([['F-2', true], ['Mill', true]]);
  expect(label(tree!.toJSON())).toContain('Only an admin can change employee ID or department');
});

it('lets admins edit employee ID and department while re-enrolling a worker', async () => {
  await render('admin', 'worker_id=w1');
  expect(identityInputs().map(input => [input.props.value, input.props.readOnly])).toEqual([['F-2', false], ['Mill', false]]);
  expect(label(tree!.toJSON())).not.toContain('Only an admin can change employee ID or department');
});

it('keeps admin manual entry of a new worker editable', async () => {
  await render('admin', '');
  expect(identityInputs().map(input => input.props.readOnly)).toEqual([true, true]);
  const manual = tree!.root.findAllByType('button').find(node => label(node).includes('Add manually'))!;
  await act(async () => manual.props.onClick());
  expect(identityInputs().map(input => input.props.readOnly)).toEqual([false, false]);
});

it('does not offer manual entry to the enrollment role', async () => {
  await render('enrollment', '');
  expect(tree!.root.findAllByType('button').some(node => label(node).includes('Add manually'))).toBe(false);
  expect(identityInputs().map(input => input.props.readOnly)).toEqual([true, true]);
});
