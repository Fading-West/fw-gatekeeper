import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import EnrollPage from './page';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'admin' }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => children }));

const alex = { name: 'Alex Smith', employeeId: 'E-1', department: 'Assembly', status: 'not_enrolled' };
const blair = { name: 'Blair Jones', employeeId: 'E-2', department: 'Finishing', status: 'enrolled', workerId: 'worker-2' };
const response = (suggestions: object[]) => ({ ok: true, json: async () => ({ suggestions }) });
let tree: ReactTestRenderer;
let fetchMock: ReturnType<typeof vi.fn>;
const input = () => tree.root.findByProps({ id: 'employee-name' });
const options = () => tree.root.findAllByProps({ role: 'option' });
async function search(value: string) { await act(async () => input().props.onChange({ target: { value } })); }
async function enter() { await act(async () => input().props.onKeyDown({ key: 'Enter', preventDefault: vi.fn() })); }

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fetchMock = vi.fn().mockResolvedValue(response([alex]));
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => { tree = create(<EnrollPage />); await vi.advanceTimersByTimeAsync(200); });
  // Effects schedule their debounce after the first render commits.
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  expect(options()).toHaveLength(1);
});
afterEach(async () => { await act(async () => tree.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('cannot enroll a previous search result while the new name is debouncing', async () => {
  await search('Blair');
  expect(options()).toHaveLength(0);
  expect(input().props['aria-expanded']).toBe(false);
  await enter();
  expect(input().props.value).toBe('Blair');
  expect(input().props.readOnly).toBe(false);
});

it('keeps old identities unavailable while a search is pending and after it fails', async () => {
  let reject!: (error: Error) => void;
  fetchMock.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  await search('Blair');
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  await enter();
  expect(input().props.value).toBe('Blair');
  expect(options()).toHaveLength(0);
  await act(async () => reject(new Error('offline')));
  expect(tree.root.findAllByProps({ role: 'alert' })).toHaveLength(1);
  await enter();
  expect(input().props.value).toBe('Blair');
  expect(options()).toHaveLength(0);
});

it('does not select an employee from the previous enrollment-status filter', async () => {
  const filter = tree.root.findAllByType('button').find(node => node.children[0] === 'Enrolled')!;
  await act(async () => filter.props.onClick());
  expect(options()).toHaveLength(0);
  await enter();
  expect(input().props.value).toBe('');
  expect(input().props.readOnly).toBe(false);
});

it('rejects an old result click after the query has changed', async () => {
  const oldClick = options()[0].props.onClick;
  await search('Blair');
  await act(async () => oldClick());
  expect(input().props.value).toBe('Blair');
  expect(input().props.readOnly).toBe(false);
});

it('ignores a late response for the previous query and selects the current result', async () => {
  let resolveAlex!: (value: unknown) => void;
  fetchMock.mockImplementationOnce(() => new Promise(done => { resolveAlex = done; }));
  await search('Alex');
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  fetchMock.mockResolvedValueOnce(response([blair]));
  await search('Blair');
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  await act(async () => resolveAlex(response([alex])));
  expect(options()).toHaveLength(1);
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({
    name: blair.name, employee_id: blair.employeeId, department: blair.department, identity_revision: 'current-blair',
  }) });
  await enter();
  expect(fetchMock).toHaveBeenCalledWith('/api/workers?id=worker-2');
  expect(input().props.value).toBe('Blair Jones');
  expect(input().props.readOnly).toBe(true);
});

it('still allows selecting an employee from the loaded roster by click', async () => {
  await act(async () => options()[0].props.onClick());
  expect(input().props.value).toBe('Alex Smith');
  expect(input().props.readOnly).toBe(true);
});

it('cannot select a hidden roster identity by pressing Enter during manual enrollment', async () => {
  const manual = tree.root.findAllByType('button').find(node => node.children.some(child => typeof child === 'string' && child.includes('Add manually')))!;
  await act(async () => manual.props.onClick());
  await search('Alex New Hire');
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  expect(options()).toHaveLength(0);
  expect(input().props['aria-expanded']).toBe(false);
  await enter();
  expect(input().props.value).toBe('Alex New Hire');
  expect(input().props.readOnly).toBe(false);
});
