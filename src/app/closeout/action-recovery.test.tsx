import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CloseoutPage from './page';
const context = vi.hoisted(() => ({ actor: 'synthetic-recovery-0', next: 0, role: 'enrollment' }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('date=2026-09-03') }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => context.role }));
vi.mock('@/hooks/useCloseoutActor', () => ({ useCloseoutActor: () => context.actor }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
const label = (node: any): string => typeof node === 'string' ? node : (node?.children || []).map(label).join('');
let tree: ReactTestRenderer;
beforeEach(() => {
  context.actor = `synthetic-recovery-${++context.next}`; context.role = 'enrollment';
  const storage = new Map<string, string>();
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
});
afterEach(async () => { if (tree) await act(async () => tree.unmount()); vi.unstubAllGlobals(); });
const button = (text: string) => tree.root.findAllByType('button').find(node => label(node) === text)!;
it.each(['lost response', 'malformed acknowledgement', 'untyped 500'])('restores and retries original completion after %s and a later reopen', async failure => {
  const posts: any[] = []; let reads = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)); posts.push(body);
      if (posts.length === 1) {
        if (failure === 'lost response') throw new Error('Response lost');
        if (failure === 'untyped 500') return { ok: false, status: 500, json: async () => ({ error: 'Uncertain server failure' }) };
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ id: 'synthetic-closeout', status: 'completed', revision: 1, requestId: body.request_id, actorUserId: context.actor }) };
    }
    reads++;
    return { ok: true, json: async () => ({ date: '2026-09-03', closeout: reads === 1 ? null : { status: 'reopened', revision: 2, notes: 'Newer supervisor notes' },
      blocker_evidence: reads === 1 ? 'old-evidence' : 'new-evidence', summary: {}, checklist: [], blockers: [], action_links: [], can_complete: true }) };
  }));
  await act(async () => { tree = create(<CloseoutPage />); });
  await act(async () => tree.root.findByType('textarea').props.onChange({ target: { value: 'Original intent notes' } }));
  await act(async () => button('Complete closeout').props.onClick());
  await act(async () => tree.unmount());
  await act(async () => { tree = create(<CloseoutPage />); });
  expect(tree.root.findByType('textarea').props.value).toBe('Newer supervisor notes');
  expect(label(tree.root.findByProps({ 'data-testid': 'saved-closeout-action' }))).toContain('Original intent notes');
  expect(button('Complete closeout').props.disabled).toBe(true);
  context.role = 'viewer';
  await act(async () => tree.update(<CloseoutPage />));
  expect(button('Retry saved action').props.disabled).toBe(true);
  context.role = 'enrollment';
  await act(async () => tree.update(<CloseoutPage />));
  await act(async () => button('Retry saved action').props.onClick());
  expect(posts).toHaveLength(2);
  expect(posts[1]).toEqual(posts[0]);
  expect(posts[1]).toMatchObject({ action: 'complete', expected_revision: null, notes: 'Original intent notes', blocker_evidence: 'old-evidence' });
  expect(tree.root.findByType('textarea').props.value).toBe('Newer supervisor notes');
  expect(tree.root.findAllByProps({ 'data-testid': 'saved-closeout-action' })).toHaveLength(0);
});
it('does not preserve or submit an acknowledged blocker draft without its required note', async () => {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ({ ok: true, json: async () => ({ date: '2026-09-03', closeout: null,
    blocker_evidence: 'current-evidence', summary: { kiosk_warnings: 1 }, checklist: [],
    blockers: [{ id: 'kiosk', label: 'Kiosk unavailable', count: 1, href: '/kiosks' }], action_links: [], can_complete: false }) }));
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => { tree = create(<CloseoutPage />); });
  await act(async () => tree.root.findAllByType('input').find(node => node.props.type === 'checkbox')!.props.onChange({ target: { checked: true } }));
  await act(async () => button('Save notes').props.onClick());
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);
  expect(tree.root.findAllByProps({ 'data-testid': 'saved-closeout-action' })).toHaveLength(0);
  expect(tree.root.findByType('textarea').props.readOnly).toBe(false);
});
it('reconciles a definite new-blocker rejection and completes with a fresh explicit intent', async () => {
  const posts: any[] = []; let reads = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)); posts.push(body);
      if (posts.length === 1) return { ok: false, status: 409, json: async () => ({ code: 'CLOSEOUT_BLOCKERS_CHANGED', error: 'Review the new blocker' }) };
      return { ok: true, status: 200, json: async () => ({ id: 'synthetic-closeout', status: 'completed', revision: 1, requestId: body.request_id, actorUserId: context.actor }) };
    }
    reads++;
    return { ok: true, json: async () => ({ date: '2026-09-03', closeout: posts.length < 2 ? null : { status: 'completed', revision: 1, notes: 'Reviewed shift evidence', snapshot: {} },
      blocker_evidence: reads === 1 ? 'no-blockers' : 'new-blocker', summary: { kiosk_warnings: reads === 1 ? 0 : 1 }, checklist: [],
      blockers: reads === 1 ? [] : [{ id: 'kiosk', label: 'Kiosk unavailable', count: 1, href: '/kiosks' }], action_links: [], can_complete: reads === 1 }) };
  }));
  await act(async () => { tree = create(<CloseoutPage />); });
  await act(async () => tree.root.findByType('textarea').props.onChange({ target: { value: 'Reviewed shift evidence' } }));
  await act(async () => button('Complete closeout').props.onClick());
  expect(tree.root.findAllByProps({ 'data-testid': 'saved-closeout-action' })).toHaveLength(1);
  expect(button('Complete closeout').props.disabled).toBe(true);
  await act(async () => button('Review current record').props.onClick());
  expect(tree.root.findByType('textarea').props.value).toBe('Reviewed shift evidence');
  await act(async () => tree.root.findAllByType('input').find(node => node.props.type === 'checkbox')!.props.onChange({ target: { checked: true } }));
  await act(async () => button('Complete closeout').props.onClick());
  expect(posts).toHaveLength(2);
  expect(posts[1]).toMatchObject({ expected_revision: null, notes: 'Reviewed shift evidence', acknowledged_blockers: true, blocker_evidence: 'new-blocker' });
  expect(posts[1].request_id).not.toBe(posts[0].request_id);
  expect(tree.root.findAllByProps({ 'data-testid': 'saved-closeout-action' })).toHaveLength(0);
  expect(tree.root.findByType('textarea').props.readOnly).toBe(true);
});
