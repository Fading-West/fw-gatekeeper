import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import KiosksPage from './page';
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
afterEach(() => vi.unstubAllGlobals());
it('renders amber stalled roster tiles with awaiting yes/no/unknown and preserves the applied time', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url === '/api/kiosks' ? [] : ({
    kiosks: { total: 4, counts: { online: 4 }, rows: [true, false, null, false].map((waiting, i) => ({
      id: `k-${i}`, name: `Gate ${i}`, status: 'online', roster_applied_at: '2026-10-29T12:00:00Z',
      roster_retry_since: '2026-10-30T11:30:00Z', roster_confirmation_stalled: i < 3, roster_changes_waiting: waiting,
    })) }, sync: { ready_worker_count: 0 },
  }) })));
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<KiosksPage />); });
  try {
    const tiles = tree.root.findAllByType('div').filter(node => node.findAllByType('p').some(p => p.children.includes('Last applied roster')) && node.findAllByType('p').length < 6);
    expect(tiles).toHaveLength(4);
    const text = (node: typeof tiles[number]): string => node.children.map(child => typeof child === 'string' ? child : text(child as typeof node)).join(' ').replace(/\s+/g, ' ');
    for (let i = 0; i < 4; i++) {
      expect(tiles[i].props.className.includes('border-amber')).toBe(i < 3);
      expect(text(tiles[i])).toContain(`Roster changes awaiting confirmation: ${i === 0 ? 'Yes' : i === 2 ? 'Unknown' : 'No'}`);
      expect(text(tiles[i])).toContain('Oct 29');
    }
    expect(text(tiles[0])).toContain('Confirmation stalled');
    expect(text(tiles[3])).not.toContain('Confirmation stalled');
  } finally { await act(async () => tree.unmount()); }
});
