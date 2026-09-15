import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import ExceptionsPage from './page';
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('date=2026-09-01') }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'admin' }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
const label = (node: any): string => typeof node === 'string' ? node : (node?.children || []).map(label).join('');
let tree: ReactTestRenderer;
afterEach(async () => { if (tree) await act(async () => tree.unmount()); vi.unstubAllGlobals(); });
it('reuses the posted request ID after a lost response, including closing and reopening the correction', async () => {
  vi.stubGlobal('document', { activeElement: null });
  vi.stubGlobal('HTMLElement', class {});
  const posted: any[] = [];
  const payload = { date: '2026-09-01', summary: {}, exceptions: [{
    key: 'missing-worker', date: '2026-09-01', worker_id: 'worker', worker_name: 'Worker', department: 'Operations',
    type: 'missing_arrival', severity: 'warning', status: 'open', links: {}, title: 'Missed scan',
    suggested_resolution: { can_apply: true, action: 'add_clock_in', corrected_time: '08:00',
      source_exception_key: 'missing-worker', reason: 'Verified arrival', label: 'Add clock-in', cta: 'Correct scan' },
  }] };
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { posted.push(JSON.parse(String(init.body))); throw new Error('Response lost'); }
    return { ok: true, json: async () => payload };
  }));
  await act(async () => { tree = create(<ExceptionsPage />); });
  const button = (text: string) => tree.root.findAllByType('button').find((node) => label(node) === text)!;
  await act(async () => button('Correct scan').props.onClick());
  await act(async () => button('Save correction').props.onClick());
  await act(async () => button('Save correction').props.onClick());
  await act(async () => button('Close').props.onClick());
  await act(async () => button('Correct scan').props.onClick());
  await act(async () => button('Save correction').props.onClick());
  expect(posted).toHaveLength(3);
  expect(posted[0].request_id).toEqual(expect.any(String));
  expect(posted[1]).toEqual(posted[0]);
  expect(posted[2]).toEqual(posted[0]);
});
