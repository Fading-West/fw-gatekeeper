import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import ExceptionsPage from './page';
const toast = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('date=2026-09-14') }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'admin' }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
const label = (node: any): string => typeof node === 'string' ? node : (node?.children || []).map(label).join('');
let tree: ReactTestRenderer;
afterEach(async () => {
  if (tree) await act(async () => tree.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  toast.mockReset();
});

it('refuses an exception correction at a time that has not happened yet today', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-14T15:00:00Z')); // 10:00 factory time
  vi.stubGlobal('document', { activeElement: null });
  vi.stubGlobal('HTMLElement', class {});
  const posted: any[] = [];
  const payload = { date: '2026-09-14', summary: {}, exceptions: [{
    key: 'arrival', source_fingerprint: 'evidence', date: '2026-09-14', worker_id: 'worker', worker_name: 'Worker', department: 'Operations',
    type: 'missing_arrival', severity: 'warning', status: 'open', links: {}, title: 'Missed scan',
    suggested_resolution: { can_apply: true, action: 'add_clock_in', corrected_time: '07:00',
      source_exception_key: 'arrival', reason: 'Verified arrival', label: 'Add clock-in', cta: 'Correct scan' },
  }] };
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { posted.push(JSON.parse(String(init.body))); return { ok: true, status: 201, json: async () => ({ id: 'correction' }) }; }
    return { ok: true, json: async () => payload };
  }));
  await act(async () => { tree = create(<ExceptionsPage />); });
  const button = (text: string) => tree.root.findAllByType('button').find((node) => label(node) === text)!;
  await act(async () => button('Correct scan').props.onClick());
  // A 07:30 -> 17:30 slip: the supervisor edits both the time and the reason.
  await act(async () => tree.root.findByProps({ type: 'time' }).props.onChange({ target: { value: '17:30' } }));
  await act(async () => tree.root.findAllByType('textarea').find((node) => node.props.value === 'Verified arrival')!.props.onChange({ target: { value: 'Badge reader down at arrival' } }));
  await act(async () => button('Save correction').props.onClick());
  expect(posted).toHaveLength(0);
  expect(toast).toHaveBeenCalledWith('This time has not happened yet today. Enter a time that already passed.', 'error');

  await act(async () => tree.root.findByProps({ type: 'time' }).props.onChange({ target: { value: '07:30' } }));
  await act(async () => button('Save correction').props.onClick());
  expect(posted).toHaveLength(1);
  expect(posted[0].corrected_timestamp).toBe('2026-09-14T07:30:00');
});
