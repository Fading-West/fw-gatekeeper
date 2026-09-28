import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import KiosksPage from './page';

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast }) }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('keeps a one-time secret visible and serializes credential changes until dismissal', async () => {
  const posts: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/system-health') return { ok: true, json: async () => ({
      kiosks: { total: 2, rows: [
        { id: 'kiosk-a', name: 'A', kiosk_id: 'a', status: 'online' },
        { id: 'kiosk-b', name: 'B', kiosk_id: 'b', status: 'online' },
      ], counts: { online: 2, stale: 0, offline: 0, never_synced: 0 } },
      sync: { ready_worker_count: 0 },
    }) };
    if (url === '/api/kiosks') return { ok: true, json: async () => ([
      { id: 'kiosk-a', credential_status: 'legacy' }, { id: 'kiosk-b', credential_status: 'legacy' },
    ]) };
    const id = JSON.parse(String(init?.body)).id;
    posts.push(id);
    return { ok: true, json: async () => ({ kiosk_id: id, credential: `secret-${id}` }) };
  }));

  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<KiosksPage />); });
  try {
    const issues = () => tree.root.findAllByType('button').filter((node) => node.children.includes('Issue / rotate credential'));
    const displayedSecret = () => tree.root.findAllByType('code').find((node) => String(node.children[0]).startsWith('secret-'))?.children;
    await act(async () => { issues()[0].props.onClick(); issues()[1].props.onClick(); });
    expect(posts).toEqual(['kiosk-a']);
    expect(displayedSecret()).toEqual(['secret-kiosk-a']);
    expect(issues().every((button) => button.props.disabled)).toBe(true);

    await act(async () => issues()[1].props.onClick());
    expect(posts).toEqual(['kiosk-a']);
    expect(displayedSecret()).toEqual(['secret-kiosk-a']);

    await act(async () => tree.root.findAllByType('button').find((node) => node.children.includes('Dismiss'))!.props.onClick());
    await act(async () => issues()[1].props.onClick());
    expect(posts).toEqual(['kiosk-a', 'kiosk-b']);
    expect(displayedSecret()).toEqual(['secret-kiosk-b']);
  } finally {
    await act(async () => tree.unmount());
  }
});

it('warns that revoking a legacy-only kiosk stops sync and sends confirmation only after approval', async () => {
  const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
  const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
  vi.stubGlobal('confirm', confirm);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/system-health') return { ok: true, json: async () => ({
      kiosks: { total: 1, rows: [{ id: 'kiosk-a', name: 'Front Gate', kiosk_id: 'a', status: 'online' }], counts: { online: 1, stale: 0, offline: 0, never_synced: 0 } },
      sync: { ready_worker_count: 0 },
    }) };
    if (url === '/api/kiosks') return { ok: true, json: async () => ([{ id: 'kiosk-a', credential_status: 'legacy' }]) };
    requests.push({ method: init!.method!, body: JSON.parse(String(init!.body)) });
    return { ok: true, json: async () => ({ ok: true }) };
  }));
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<KiosksPage />); });
  try {
    const revoke = () => tree.root.findAllByType('button').find(node => node.children.includes('Revoke access'))!;
    await act(async () => revoke().props.onClick());
    expect(requests).toEqual([]);
    expect(confirm.mock.calls[0][0]).toContain('Front Gate');
    expect(confirm.mock.calls[0][0]).toContain('stop syncing');
    expect(confirm.mock.calls[0][0]).toContain('shared migration key');
    await act(async () => revoke().props.onClick());
    expect(requests).toEqual([{ method: 'DELETE', body: { id: 'kiosk-a', confirmStopSync: true } }]);
  } finally {
    await act(async () => tree.unmount());
  }
});

it('shows the credential status of a newly registered kiosk without reloading', async () => {
  let registered = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/system-health') return { ok: true, json: async () => ({
      kiosks: { total: registered ? 1 : 0, rows: registered
        ? [{ id: 'new-kiosk', name: 'New Gate', kiosk_id: 'new-gate', status: 'never_synced' }] : [],
        counts: { online: 0, stale: 0, offline: 0, never_synced: registered ? 1 : 0 } },
      sync: { ready_worker_count: 0 },
    }) };
    if (url === '/api/kiosks' && init?.method === 'POST') {
      registered = true;
      return { ok: true, json: async () => ({ id: 'new-kiosk' }) };
    }
    if (url === '/api/kiosks') return { ok: true, json: async () => (registered
      ? [{ id: 'new-kiosk', credential_status: 'legacy' }] : []) };
    throw new Error(`Unexpected request: ${url}`);
  }));
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<KiosksPage />); });
  try {
    await act(async () => tree.root.findAllByType('button').find(node => node.children.includes('Add Kiosk'))!.props.onClick());
    await act(async () => tree.root.findAllByType('input').find(node => node.props.placeholder === 'e.g. Main Entrance Kiosk')!.props.onChange({ target: { value: 'New Gate' } }));
    await act(async () => tree.root.findAllByType('button').find(node => node.children.includes('Register Kiosk'))!.props.onClick());
    expect(tree.root.findAllByType('h3').some(node => node.children.includes('New Gate'))).toBe(true);
    expect(tree.root.findAllByType('span').some(node => node.children.includes('Shared key migration'))).toBe(true);
    expect(tree.root.findAllByType('span').some(node => node.children.includes('Checking credential'))).toBe(false);
  } finally {
    await act(async () => tree.unmount());
  }
});
