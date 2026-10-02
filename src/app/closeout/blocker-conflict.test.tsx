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
it('shows the signed record after a conflict refresh while preserving the rejected draft separately', async () => {
  let reads = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') return { ok: false, status: 409, json: async () => ({ code: 'CLOSEOUT_BLOCKERS_CHANGED', error: 'Changed blockers' }) };
    reads++;
    return { ok: true, json: async () => ({ date: '2026-09-03', closeout: reads === 1
      ? { status: 'open', notes: 'Saved note', acknowledged_blockers: false }
      : { status: 'completed', notes: 'Signed note', supervisor_name: 'Signing supervisor', acknowledged_blockers: true, snapshot: {} },
      blocker_evidence: 'source', summary: { kiosk_warnings: 1 }, checklist: [], blockers: [], action_links: [], can_complete: false }) };
  }));
  await act(async () => { tree = create(<CloseoutPage />); });
  await act(async () => tree.root.findByType('textarea').props.onChange({ target: { value: 'Rejected draft note' } }));
  await act(async () => tree.root.findAllByType('input').find(node => node.props.placeholder === 'Supervisor name')!.props.onChange({ target: { value: 'Draft supervisor' } }));
  await act(async () => tree.root.findAllByType('button').find(node => label(node) === 'Save notes')!.props.onClick());
  expect(tree.root.findByType('textarea').props.value).toBe('Signed note');
  expect(tree.root.findAllByType('input').find(node => node.props.placeholder === 'Supervisor name')!.props.value).toBe('Signing supervisor');
  expect(label(tree.root.findByProps({ role: 'alert' }))).toContain('Rejected draft note');
  expect(label(tree.root.findByProps({ role: 'alert' }))).toContain('Draft supervisor');
});
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
