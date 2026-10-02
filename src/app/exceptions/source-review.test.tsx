import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import ExceptionsPage from './page';
const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('date=2026-09-03') }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'enrollment' }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
const label = (node: any): string => typeof node === 'string' ? node : (node?.children || []).map(label).join('');
let tree: ReactTestRenderer;
afterEach(async () => { if (tree) await act(async () => tree.unmount()); vi.unstubAllGlobals(); vi.clearAllMocks(); });
it('refreshes an obsolete review source and retains the operator note without reporting success', async () => {
  let reads = 0;
  const source = { key: 'synthetic-source', date: '2026-09-03', type: 'scan_sequence', worker_name: 'Synthetic worker',
    title: 'Scan issue', status: 'open', severity: 'warning', review_note: '', links: {},
    suggested_resolution: { can_apply: false, action: 'review_only', label: 'Review source', reason: 'Check evidence' } };
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') return { ok: false, status: 409, json: async () => ({ code: 'EXCEPTION_SOURCE_CONFLICT', error: 'Refresh current evidence' }) };
    reads++;
    return { ok: true, json: async () => ({ date: '2026-09-03', summary: {}, exceptions: [source] }) };
  }));
  await act(async () => { tree = create(<ExceptionsPage />); });
  await act(async () => tree.root.findByType('textarea').props.onChange({ target: { value: 'Operator draft retained' } }));
  await act(async () => tree.root.findAllByType('button').find(node => label(node) === 'Reviewed')!.props.onClick());
  expect(reads).toBe(2);
  expect(tree.root.findByType('textarea').props.value).toBe('Operator draft retained');
  expect(toast).toHaveBeenCalledWith('Refresh current evidence', 'error');
  expect(toast.mock.calls.some(([text]) => String(text).includes('marked'))).toBe(false);
});
