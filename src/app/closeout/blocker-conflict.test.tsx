import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import CloseoutPage from './page';
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('date=2026-09-03') }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'enrollment' }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
const label = (node: any): string => typeof node === 'string' ? node : (node?.children || []).map(label).join('');
let tree: ReactTestRenderer;
afterEach(async () => { if (tree) await act(async () => tree.unmount()); vi.unstubAllGlobals(); });
it('refreshes changed blockers, clears acknowledgement and retains the signoff draft', async () => {
  let reads = 0;
  const posted: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      posted.push(JSON.parse(String(init.body)));
      return { ok: false, status: 409, json: async () => ({ code: 'CLOSEOUT_BLOCKERS_CHANGED', error: 'Review new blockers' }) };
    }
    reads++;
    return { ok: true, json: async () => ({ date: '2026-09-03', closeout: { status: 'open', notes: 'Saved note', acknowledged_blockers: false },
      blocker_evidence: reads === 1 ? 'original-source' : 'replacement-source', summary: { kiosk_warnings: 1 }, checklist: [],
      blockers: [{ id: 'kiosk', label: 'Review kiosk', count: 1, description: 'Offline', href: '/kiosks' }], action_links: [], can_complete: false }) };
  }));
  await act(async () => { tree = create(<CloseoutPage />); });
  await act(async () => tree.root.findByType('textarea').props.onChange({ target: { value: 'Retained draft' } }));
  await act(async () => tree.root.findAllByType('input').find(node => node.props.type === 'checkbox')!.props.onChange({ target: { checked: true } }));
  await act(async () => tree.root.findAllByType('button').find(node => label(node) === 'Save notes')!.props.onClick());
  expect(posted[0]).toMatchObject({ blocker_evidence: 'original-source', acknowledged_blockers: true });
  expect(reads).toBe(2);
  expect(tree.root.findByType('textarea').props.value).toBe('Retained draft');
  expect(tree.root.findAllByType('input').find(node => node.props.type === 'checkbox')!.props.checked).toBe(false);
});
