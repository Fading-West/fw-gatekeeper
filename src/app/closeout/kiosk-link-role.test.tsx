import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import CloseoutPage from './page';

const role = vi.hoisted(() => ({ current: 'admin' }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('date=2026-09-10') }));
vi.mock('@/hooks/useCloseoutActor', () => ({ useCloseoutActor: () => 'role-test-actor' }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => role.current }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));

let tree: ReactTestRenderer;
afterEach(async () => { if (tree) await act(async () => tree.unmount()); vi.unstubAllGlobals(); });

// Mirrors convex/shiftCloseouts.ts: the kiosk blocker, its proof, the draft
// source links and the action links all point at the admin-only /kiosks page.
const kioskBlocker = {
  id: 'kiosk_warnings', label: 'Kiosk trust warnings', status: 'blocked', count: 1, href: '/kiosks',
  description: '1 kiosk needs attention.',
  proof: { count: 1, label: 'kiosk trust warnings', href: '/kiosks', exact: false },
};
const actionLinks = [
  { label: 'Briefing', href: '/briefing?date=2026-09-10' },
  { label: 'Exceptions', href: '/exceptions?date=2026-09-10&status=open' },
  { label: 'Activity Log', href: '/log?date=2026-09-10' },
  { label: 'Kiosks', href: '/kiosks' },
  { label: 'Recognition Lab', href: '/calibration/recognition?date=2026-09-10&review_status=unreviewed' },
];
const payload = {
  date: '2026-09-10', generated_at: '2026-09-10T18:00:00Z', closeout: { status: 'open', notes: '' }, summary: { kiosk_warnings: 1 },
  checklist: [kioskBlocker], blockers: [kioskBlocker], can_complete: false, suggested_note: '', action_links: actionLinks,
  closeout_draft: {
    generated_at: '2026-09-10T18:00:00Z', narrative: 'Draft',
    sections: [{
      id: 'source_review', title: 'Source review', paragraph: 'Kiosk trust needs review.',
      source_links: [...actionLinks.map((link) => ({ ...link, count: 0, exact: false })), { label: 'kiosk trust warnings', href: '/kiosks', count: 1, exact: false }],
    }],
  },
};

async function renderAs(currentRole: string) {
  role.current = currentRole;
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => payload })));
  await act(async () => { tree = create(<CloseoutPage />); });
  return tree.root.findAllByType('a').map((node) => node.props.href as string);
}

it.each(['enrollment', 'viewer'])('sends %s users to the briefing kiosk trust view instead of the admin-only Kiosks page', async (currentRole) => {
  const hrefs = await renderAs(currentRole);
  expect(hrefs.filter((href) => href.startsWith('/kiosks'))).toEqual([]);
  // Next step, checklist proof, checklist source view and the draft links still lead somewhere useful.
  expect(hrefs.filter((href) => href === '/briefing?date=2026-09-10').length).toBeGreaterThanOrEqual(4);
  expect(hrefs).toContain('/exceptions?date=2026-09-10&status=open');
});

it('keeps the Kiosks links for admins', async () => {
  const hrefs = await renderAs('admin');
  expect(hrefs.filter((href) => href === '/kiosks').length).toBeGreaterThanOrEqual(4);
});

const label = (node: any): string => typeof node === 'string' ? node : (node?.children || []).map(label).join('');

async function exportedText() {
  let exported!: Blob;
  vi.stubGlobal('URL', { createObjectURL: (blob: Blob) => { exported = blob; return 'blob:test'; }, revokeObjectURL: vi.fn() });
  vi.stubGlobal('document', { createElement: () => ({ click: vi.fn() }) });
  const exportButton = tree.root.findAllByType('button').find((node) => label(node) === 'Export')!;
  await act(async () => exportButton.props.onClick());
  return exported.text();
}

it.each(['enrollment', 'viewer'])('exports the briefing source view instead of the Kiosks page for %s users', async (currentRole) => {
  await renderAs(currentRole);
  const text = await exportedText();
  expect(text).toContain('Proof: 1 kiosk trust warnings (source view: /briefing?date=2026-09-10).');
  expect(text).not.toContain('/kiosks');
});

it('keeps the Kiosks source view in admin exports', async () => {
  await renderAs('admin');
  expect(await exportedText()).toContain('Proof: 1 kiosk trust warnings (source view: /kiosks).');
});
