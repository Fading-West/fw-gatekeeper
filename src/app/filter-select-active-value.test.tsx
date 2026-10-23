import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import BriefingPage from './briefing/page';
import ExceptionsPage from './exceptions/page';
import WorkersPage from './workers/page';

const navigation = vi.hoisted(() => ({ query: '' }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(navigation.query) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'admin' }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const date = '2026-09-01';
const text = (node: ReactTestInstance | string): string => typeof node === 'string' ? node : node.children.map(text).join('');
let tree: ReactTestRenderer | undefined;

// A <select> whose value is not among its options renders its first option ("All ...") as
// selected, so an applied filter must always be offered as an option.
function selectFor(placeholder: string) {
  const select = tree!.root.findAllByType('select').find((node) => text(node.findAllByType('option')[0]) === placeholder)!;
  return { value: select.props.value, options: select.findAllByType('option').map((option) => option.props.value) };
}

beforeEach(() => {
  navigation.query = '';
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('document', { activeElement: null, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('HTMLElement', class {});
});

afterEach(async () => {
  if (tree) await act(async () => tree!.unmount());
  tree = undefined;
  vi.unstubAllGlobals();
});

it('Exceptions keeps URL department and type filters selectable when no loaded exception matches them', async () => {
  navigation.query = `date=${date}&status=open&department=Mill&type=late_arrival`;
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ date, summary: {}, exceptions: [{
    key: 'missing-worker', date, worker_id: 'worker-1', worker_name: 'Worker', department: 'Assembly',
    type: 'missing_arrival', severity: 'warning', status: 'open', links: {}, title: 'Missed scan',
  }] }) })));
  await act(async () => { tree = create(<ExceptionsPage />); });
  expect.soft(selectFor('All departments')).toEqual({ value: 'Mill', options: ['all', 'Assembly', 'Mill'] });
  expect.soft(selectFor('All types')).toEqual({ value: 'late_arrival', options: ['all', 'late_arrival', 'missing_arrival'] });
});

it('Briefing keeps a URL department filter selectable when the briefing has no such department', async () => {
  navigation.query = `date=${date}&department=Mill`;
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({
    date, summary: {}, departments: [{ department: 'Assembly', schedule_name: 'Day', scheduled_start: '08:00', status: 'covered' }],
    workers: [], action_items: [], schedules: {}, kiosks: { counts: {} },
  }) })));
  await act(async () => { tree = create(<BriefingPage />); });
  expect(selectFor('All departments')).toEqual({ value: 'Mill', options: ['all', 'Assembly', 'Mill'] });
});

it('Workers keeps the department filter selectable after switching to a roster without that department', async () => {
  const worker = (name: string, department: string, active: number) => ({ id: name, name, department, photo_url: null, enrolled_at: '2026-10-02T08:00:00Z', active });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(
    url === '/api/kiosks' ? [] : url.includes('active=false') ? [worker('Inactive', 'Paint', 0)] : [worker('Active', 'Mill', 1)],
  )));
  await act(async () => { tree = create(<WorkersPage />); });
  await act(async () => tree!.root.findByProps({ id: 'worker-department' }).props.onChange({ target: { value: 'Mill' } }));
  await act(async () => tree!.root.findAllByType('input').find((input) => input.props.type === 'checkbox')!.props.onChange({ target: { checked: true } }));
  expect(selectFor('All departments')).toEqual({ value: 'Mill', options: ['all', 'Mill', 'Paint'] });
});
