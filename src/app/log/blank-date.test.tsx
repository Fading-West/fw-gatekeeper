import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import LogPage from './page';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('date=2026-09-14') }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'admin' }));
vi.mock('@/components/AttendanceTable', () => ({ default: () => null, attendanceRowId: (id: string) => id }));
const label = (node: any): string => typeof node === 'string' ? node : (node?.children || []).map(label).join('');
let tree: ReactTestRenderer;
let fetchMock: ReturnType<typeof vi.fn>;
const button = (text: string) => tree.root.findAllByType('button').find((node) => label(node).trim() === text)!;
const dateInput = () => tree.root.findAllByType('input').find((node) => node.props.type === 'date')!;

beforeEach(async () => {
  // The API resolves a missing or empty ?date= to factory today.
  const todaysEvent = { id: 'today', worker_id: 'worker', worker_name: 'Today Worker', worker_department: 'Assembly', timestamp: '2026-10-20T08:00:00', event_type: 'clock_in' };
  fetchMock = vi.fn(async (url: string) => ({ ok: true, json: async () =>
    url.startsWith('/api/attendance-corrections') ? { corrections: [] } : [todaysEvent],
  }));
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => { tree = create(<LogPage />); });
});
afterEach(async () => { await act(async () => tree.unmount()); vi.unstubAllGlobals(); });

it('does not load or export another day when the date field is cleared', async () => {
  expect(button('Export CSV').props.disabled).toBe(false);
  fetchMock.mockClear();
  await act(async () => dateInput().props.onChange({ target: { value: '' } }));

  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([]);
  expect(button('Export CSV').props.disabled).toBe(true);
  expect(button('Export hours CSV').props.disabled).toBe(true);
  expect(label(tree.toJSON())).toContain('Choose a date to view the activity log.');

  await act(async () => dateInput().props.onChange({ target: { value: '2026-09-15' } }));
  expect(fetchMock.mock.calls.map(([url]) => url)).toContain('/api/attendance?date=2026-09-15');
  expect(button('Export CSV').props.disabled).toBe(false);
});
