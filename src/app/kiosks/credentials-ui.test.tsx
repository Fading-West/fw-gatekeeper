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
