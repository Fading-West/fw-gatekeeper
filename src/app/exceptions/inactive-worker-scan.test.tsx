import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import ExceptionsPage from './page';

const role = vi.hoisted(() => ({ current: 'admin' }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('date=2026-09-03') }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => role.current }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));

const label = (node: any): string => typeof node === 'string' ? node : (node?.children || []).map(label).join('');
const activityLog = '/log?date=2026-09-03&worker_id=w1&attendance_id=a1';
const payload = { date: '2026-09-03', summary: {}, exceptions: [{
  key: '2026-09-03:inactive_worker_scan:w1:a1', date: '2026-09-03', type: 'inactive_worker_scan',
  severity: 'critical', status: 'open', title: 'Alex Removed scanned after being deactivated',
  description: 'Alex Removed was deactivated at 2026-09-03 09:00, but kiosk Front door recorded a clock in at 10:15.',
  worker_id: 'w1', worker_name: 'Alex Removed', department: 'Framing', kiosk_id: 'front-1', kiosk_name: 'Front door',
  first_seen: '2026-09-03T10:15:00', last_seen: '2026-09-03T10:15:00', event_count: 1, attendance_id: 'a1',
  review_note: null, reviewed_at: null, links: { activity_log: activityLog, worker: '/workers' },
  suggested_resolution: { action: 'review_only', label: 'Review deactivated-worker scan', cta: 'Review source',
    reason: 'Deactivated worker scan', href: activityLog, source_href: activityLog, can_apply: false,
    disabled_reason: 'The scan is kept as door evidence.', source_exception_key: '2026-09-03:inactive_worker_scan:w1:a1' },
}] };

let tree: ReactTestRenderer;
afterEach(async () => {
  if (tree) await act(async () => tree.unmount());
  vi.unstubAllGlobals();
  role.current = 'admin';
});

async function render(fetchImpl: (url: string, init?: RequestInit) => Promise<any>) {
  vi.stubGlobal('fetch', vi.fn(fetchImpl));
  await act(async () => { tree = create(<ExceptionsPage />); });
  return {
    buttons: () => tree.root.findAllByType('button').map(label),
    text: () => label(tree.toJSON()),
    links: () => tree.root.findAllByType('a').map((node) => ({ text: label(node), href: node.props.href })),
    options: () => tree.root.findAllByType('option').map((node) => ({ value: node.props.value, text: label(node) })),
  };
}

it('labels the type, offers it as a filter, and lets admins review with an optional note', async () => {
  const patches: any[] = [];
  const page = await render(async (_url, init) => {
    if (init?.method === 'PATCH') { patches.push(JSON.parse(String(init.body))); return { ok: true, json: async () => ({}) }; }
    return { ok: true, json: async () => payload };
  });
  expect(page.text()).toContain('Deactivated worker scan');
  expect(page.options()).toContainEqual({ value: 'inactive_worker_scan', text: 'Deactivated worker scan' });
  expect(page.buttons()).toEqual(expect.arrayContaining(['Reviewed', 'Resolved', 'Ignore']));
  expect(page.links()).toContainEqual({ text: 'Review source', href: activityLog });
  expect(tree.root.findAllByType('textarea').some((node) => node.props.placeholder === 'Optional note')).toBe(true);

  const reviewed = tree.root.findAllByType('button').find((node) => label(node) === 'Reviewed')!;
  await act(async () => reviewed.props.onClick());
  expect(patches).toEqual([{ exception_key: '2026-09-03:inactive_worker_scan:w1:a1', date: '2026-09-03', type: 'inactive_worker_scan', status: 'reviewed' }]);
});

it('shows viewers the exception without review controls', async () => {
  role.current = 'viewer';
  const page = await render(async () => ({ ok: true, json: async () => payload }));
  expect(page.text()).toContain('Alex Removed scanned after being deactivated');
  expect(page.buttons().some((text) => ['Reviewed', 'Resolved', 'Ignore'].includes(text))).toBe(false);
  expect(page.links()).toContainEqual({ text: 'Review source', href: activityLog });
});

it('keeps the existing honest error state when the fetch fails', async () => {
  const page = await render(async () => ({ ok: false, status: 500, json: async () => ({ error: 'Shift exceptions are unavailable' }) }));
  expect(tree.root.findAll((node) => node.props?.role === 'alert').length).toBeGreaterThan(0);
  expect(page.text()).not.toContain('Deactivated worker scan');
});
