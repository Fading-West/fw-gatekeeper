import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import ExceptionsPage from './page';

const role = vi.hoisted(() => ({ current: 'admin' }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('date=2026-09-01') }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => role.current }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));

let tree: ReactTestRenderer;
afterEach(async () => { if (tree) await act(async () => tree.unmount()); vi.unstubAllGlobals(); });

const payload = { date: '2026-09-01', summary: {}, exceptions: [{
  key: 'recognition-review:attempt-1', date: '2026-09-01', worker_id: 'worker', worker_name: 'Worker', department: 'Operations',
  type: 'recognition_review', severity: 'info', status: 'open', title: 'Recognition needs review',
  links: {
    activity_log: '/log?date=2026-09-01&worker_id=worker',
    recognition_lab: '/calibration/recognition?date=2026-09-01&review_status=all&attempt_id=attempt-1',
    kiosk: '/kiosks',
  },
  suggested_resolution: { can_apply: false, action: 'review_source', href: '/log?date=2026-09-01&worker_id=worker', cta: 'Review source', label: 'Review source' },
}] };

async function renderAs(currentRole: string) {
  role.current = currentRole;
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => payload })));
  await act(async () => { tree = create(<ExceptionsPage />); });
  return tree.root.findAllByType('a').map((node) => node.props.href);
}

it.each(['enrollment', 'viewer'])('does not link %s users to the admin-only Kiosks page', async (currentRole) => {
  const hrefs = await renderAs(currentRole);
  expect(hrefs).toContain('/calibration/recognition?date=2026-09-01&review_status=all&attempt_id=attempt-1');
  expect(hrefs).not.toContain('/kiosks');
});

it('keeps the Kiosks link for admins', async () => {
  expect(await renderAs('admin')).toContain('/kiosks');
});
