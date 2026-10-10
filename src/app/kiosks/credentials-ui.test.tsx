import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import KiosksPage from './page';

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast }) }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('keeps a one-time secret visible and serializes credential changes until dismissal', async () => {
  const posts: string[] = [];
  vi.stubGlobal('confirm', vi.fn(() => true));
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

const oneKioskHealth = () => ({ ok: true, json: async () => ({
  kiosks: { total: 1, rows: [{ id: 'kiosk-a', name: 'Front Gate', kiosk_id: 'a', status: 'online' }], counts: { online: 1, stale: 0, offline: 0, never_synced: 0 } },
  sync: { ready_worker_count: 0 },
}) });
const findButton = (tree: ReturnType<typeof create>, label: string) => tree.root.findAllByType('button').find(node => node.children.includes(label));
const badgeShows = (tree: ReturnType<typeof create>, label: string) => tree.root.findAllByType('span').some(node => node.children.includes(label));

it('requires confirmation naming the kiosk before issuing or rotating, and cancel sends nothing', async () => {
  const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
  const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
  vi.stubGlobal('confirm', confirm);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/system-health') return oneKioskHealth();
    if (url === '/api/kiosks') return { ok: true, json: async () => ([{ id: 'kiosk-a', credential_status: 'legacy' }]) };
    requests.push({ method: init!.method!, body: JSON.parse(String(init!.body)) });
    return { ok: true, json: async () => ({ kiosk_id: 'a', credential: 'secret-a' }) };
  }));
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<KiosksPage />); });
  try {
    await act(async () => findButton(tree, 'Issue / rotate credential')!.props.onClick());
    expect(requests).toEqual([]);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toContain('Front Gate will stop syncing until the new credential is installed on its device.');
    await act(async () => findButton(tree, 'Issue / rotate credential')!.props.onClick());
    expect(requests).toEqual([{ method: 'POST', body: { id: 'kiosk-a' } }]);
  } finally {
    await act(async () => tree.unmount());
  }
});

it.each([
  ['the network drops the response', () => Promise.reject(new TypeError('Failed to fetch'))],
  ['a proxy times out with an unreadable body', async () => ({ ok: false, status: 504, json: async () => { throw new SyntaxError('Unexpected token <'); } })],
  ['the route returns a JSON 500 after the Convex call throws', async () => ({ ok: false, status: 500, json: async () => ({ error: 'Failed to issue kiosk credential' }) })],
])('reports an unknown outcome and refreshes credential status when %s', async (_case, issueResponse) => {
  vi.stubGlobal('confirm', vi.fn(() => true));
  let statusReads = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/system-health') return oneKioskHealth();
    if (url === '/api/kiosks') {
      statusReads += 1;
      return { ok: true, json: async () => ([{ id: 'kiosk-a', credential_status: statusReads === 1 ? 'legacy' : 'device' }]) };
    }
    return issueResponse();
  }));
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<KiosksPage />); });
  try {
    expect(badgeShows(tree, 'Shared key migration')).toBe(true);
    await act(async () => findButton(tree, 'Issue / rotate credential')!.props.onClick());
    const alert = tree.root.findAll(node => node.type === 'div' && node.props.role === 'alert')
      .flatMap(node => node.findAllByType('p')).flatMap(node => node.children).join('');
    expect(alert).toContain('outcome unknown');
    expect(alert).toContain('Front Gate');
    expect(alert).toContain('issue a new credential');
    expect(toast).not.toHaveBeenCalledWith(expect.stringMatching(/failed/i), 'error');
    expect(statusReads).toBe(2);
    expect(badgeShows(tree, 'Device credential active')).toBe(true);
    expect(findButton(tree, 'Issue / rotate credential')!.props.disabled).toBe(false);
  } finally {
    await act(async () => tree.unmount());
  }
});

it('shows credential status as unavailable with a retry instead of checking forever, including after a revoke', async () => {
  vi.stubGlobal('confirm', vi.fn(() => true));
  let statusOk = false;
  let statusReads = 0;
  let revokeOk = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/system-health') return oneKioskHealth();
    if (url === '/api/kiosks') {
      statusReads += 1;
      if (!statusOk) throw new TypeError('Failed to fetch');
      return { ok: true, json: async () => ([{ id: 'kiosk-a', credential_status: revokeOk ? 'revoked' : 'legacy' }]) };
    }
    if (!revokeOk) return { ok: false, status: 404, json: async () => ({ error: 'Active kiosk not found' }) };
    return { ok: true, json: async () => ({ ok: true }) };
  }));
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<KiosksPage />); });
  try {
    expect(badgeShows(tree, 'Credential status unavailable')).toBe(true);
    expect(badgeShows(tree, 'Checking credential')).toBe(false);

    statusOk = true;
    await act(async () => findButton(tree, 'Retry')!.props.onClick());
    expect(badgeShows(tree, 'Shared key migration')).toBe(true);
    expect(findButton(tree, 'Retry')).toBeUndefined();

    // A rejected revoke still refreshes the badge.
    const readsBeforeFailedRevoke = statusReads;
    await act(async () => findButton(tree, 'Revoke access')!.props.onClick());
    expect(toast).toHaveBeenCalledWith('Active kiosk not found', 'error');
    expect(statusReads).toBe(readsBeforeFailedRevoke + 1);

    // A successful revoke whose refresh fails must not leave the old badge in place.
    revokeOk = true;
    statusOk = false;
    await act(async () => findButton(tree, 'Revoke access')!.props.onClick());
    expect(badgeShows(tree, 'Shared key migration')).toBe(false);
    expect(badgeShows(tree, 'Credential status unavailable')).toBe(true);

    statusOk = true;
    await act(async () => findButton(tree, 'Retry')!.props.onClick());
    expect(badgeShows(tree, 'Credential revoked')).toBe(true);
  } finally {
    await act(async () => tree.unmount());
  }
});

it('shows a definite rejection from a 4xx issue response as an error, not an unknown outcome', async () => {
  vi.stubGlobal('confirm', vi.fn(() => true));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/system-health') return oneKioskHealth();
    if (url === '/api/kiosks') return { ok: true, json: async () => ([{ id: 'kiosk-a', credential_status: 'legacy' }]) };
    return { ok: false, status: 404, json: async () => ({ error: 'Active kiosk not found' }) };
  }));
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<KiosksPage />); });
  try {
    await act(async () => findButton(tree, 'Issue / rotate credential')!.props.onClick());
    expect(toast).toHaveBeenCalledWith('Active kiosk not found', 'error');
    expect(tree.root.findAll(node => node.type === 'div' && node.props.role === 'alert')).toHaveLength(0);
  } finally {
    await act(async () => tree.unmount());
  }
});

it.each([
  ['the network drops the response', () => Promise.reject(new TypeError('Failed to fetch'))],
  ['the route returns a JSON 500', async () => ({ ok: false, status: 500, json: async () => ({ error: 'Failed to revoke kiosk credential' }) })],
])('does not claim a revoke failed when %s, and shows the refreshed status', async (_case, revokeResponse) => {
  vi.stubGlobal('confirm', vi.fn(() => true));
  let statusReads = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/system-health') return oneKioskHealth();
    if (url === '/api/kiosks') {
      statusReads += 1;
      return { ok: true, json: async () => ([{ id: 'kiosk-a', credential_status: statusReads === 1 ? 'legacy' : 'revoked' }]) };
    }
    return revokeResponse();
  }));
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<KiosksPage />); });
  try {
    await act(async () => findButton(tree, 'Revoke access')!.props.onClick());
    expect(toast).toHaveBeenCalledWith('Could not confirm whether access for Front Gate was revoked. Check its credential status.', 'error');
    expect(toast).not.toHaveBeenCalledWith(expect.stringMatching(/failed/i), 'error');
    expect(statusReads).toBe(2);
    expect(badgeShows(tree, 'Credential revoked')).toBe(true);
  } finally {
    await act(async () => tree.unmount());
  }
});
