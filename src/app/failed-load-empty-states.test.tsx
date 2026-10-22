import { act, create, type ReactTestInstance, type ReactTestRenderer, type ReactTestRendererJSON } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BriefingPage from './briefing/page';
import ExceptionsPage from './exceptions/page';
import KiosksPage from './kiosks/page';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('') }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'admin' }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

type Mode = 'pending' | 'error' | 'empty' | 'fallback';

const pages = [
  {
    name: 'Briefing',
    Page: BriefingPage,
    endpoint: '/api/shift-briefing',
    loadingText: 'Loading coverage briefing...',
    emptyText: ['No action items', 'are clear for this view', 'No scheduled coverage in this view', 'No workers match', 'Coverage on track'],
    emptyPayload: (date: string | null) => ({
      date,
      generated_at: `${date}T08:00:00Z`,
      summary: { expected: 0, present: 0, late: 0, missing: 0, open_exceptions: 0, recognition_reviews: 0, kiosk_warnings: 0, critical_actions: 0 },
      departments: [],
      workers: [],
      action_items: [],
      schedules: { active_today: 0 },
      kiosks: { total: 0, counts: { online: 0, stale: 0, offline: 0, never_synced: 0 } },
    }),
  },
  {
    name: 'Exceptions',
    Page: ExceptionsPage,
    endpoint: '/api/shift-exceptions',
    loadingText: 'Loading shift exceptions...',
    emptyText: ['No exceptions in this view'],
    emptyPayload: (date: string | null) => ({ date, summary: { open: 0, critical: 0, warning: 0, info: 0 }, exceptions: [] }),
  },
  {
    name: 'Kiosks',
    Page: KiosksPage,
    endpoint: '/api/system-health',
    loadingText: 'Loading kiosk readiness…',
    emptyText: ['No kiosks are registered yet', 'No kiosks registered', 'All kiosks online', '0 devices'],
    emptyPayload: () => ({
      checked_at: '2026-10-22T08:00:00Z',
      kiosks: { total: 0, counts: { online: 0, stale: 0, offline: 0, never_synced: 0 }, stale_threshold_minutes: 15, offline_threshold_minutes: 60, rows: [] },
      sync: { ready_worker_count: 0, last_attendance_upload: null },
      warnings: [],
    }),
  },
];

let tree: ReactTestRenderer | undefined;

function textOf(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node === null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  return (node.children ?? []).map((child) => (typeof child === 'string' ? child : ` ${textOf(child)} `)).join('');
}

const pageText = () => textOf(tree!.toJSON()).replace(/\s+/g, ' ');
const tileValues = () => tree!.root
  .findAll((node: ReactTestInstance) => node.type === 'p' && typeof node.props.className === 'string' && node.props.className.includes('text-2xl'))
  .map((node) => node.children.join(''));

function stubFetch(endpoint: string, mode: Mode, emptyPayload: (date: string | null) => unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/kiosks')) return { ok: true, json: async () => [] };
    if (!url.startsWith(endpoint)) throw new Error(`Unexpected request ${url}`);
    if (mode === 'pending') return new Promise(() => {});
    if (mode === 'error') return { ok: false, json: async () => ({ error: 'Synthetic outage' }) };
    const date = new URL(url, 'http://localhost').searchParams.get('date');
    return { ok: true, json: async () => mode === 'fallback'
      ? { ...(emptyPayload(date) as object), backend_unavailable: true, warning: 'Waiting for Convex deployment' }
      : emptyPayload(date) };
  }));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('document', { activeElement: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), getElementById: () => null });
  vi.stubGlobal('HTMLElement', class {});
});

afterEach(async () => {
  if (tree) await act(async () => tree!.unmount());
  tree = undefined;
  vi.unstubAllGlobals();
});

describe.each(pages)('$name', ({ name, Page, endpoint, loadingText, emptyText, emptyPayload }) => {
  it('shows a loading state, not an empty or all-clear state, while data is pending', async () => {
    stubFetch(endpoint, 'pending', emptyPayload);
    await act(async () => { tree = create(<Page />); });
    const text = pageText();
    expect(text).toContain(loadingText);
    for (const claim of emptyText) expect(text).not.toContain(claim);
    expect(tileValues().length).toBeGreaterThan(0);
    expect(tileValues()).not.toContain('0');
  });

  it('shows the error without an empty or all-clear state when the load fails', async () => {
    stubFetch(endpoint, 'error', emptyPayload);
    await act(async () => { tree = create(<Page />); });
    const text = pageText();
    expect(tree!.root.findByProps({ role: 'alert' }).children.join('')).toContain('Synthetic outage');
    expect(text).not.toContain(loadingText);
    for (const claim of emptyText) expect(text).not.toContain(claim);
    expect(tileValues().length).toBeGreaterThan(0);
    expect(tileValues()).not.toContain('0');
    if (name === 'Briefing') expect(text).not.toContain('Loading briefing');
    if (name === 'Kiosks') expect(text).not.toContain('Checking readiness');
  });

  it('still shows the normal empty state after a successful load with no data', async () => {
    stubFetch(endpoint, 'empty', emptyPayload);
    await act(async () => { tree = create(<Page />); });
    const text = pageText();
    expect(tree!.root.findAllByProps({ role: 'alert' })).toHaveLength(0);
    expect(text).not.toContain(loadingText);
    const expected = name === 'Briefing'
      ? ['No action items', 'No scheduled coverage in this view', 'No workers match']
      : name === 'Exceptions' ? ['No exceptions in this view'] : ['No kiosks are registered yet', '0 devices'];
    for (const claim of expected) expect(text).toContain(claim);
    expect(tileValues().every((value) => value === '0')).toBe(true);
  });
});

// These routes use a 200 fallback payload when their Convex function is absent.
it.each(pages.filter(({ name }) => name !== 'Kiosks'))('$name treats a deployment fallback as unavailable', async ({ Page, endpoint, emptyPayload, emptyText }) => {
  stubFetch(endpoint, 'fallback', emptyPayload);
  await act(async () => { tree = create(<Page />); });
  expect(pageText()).toContain('Waiting for Convex deployment');
  for (const claim of emptyText) expect(pageText()).not.toContain(claim);
  expect(tileValues().length).toBeGreaterThan(0);
  expect(tileValues()).not.toContain('0');
});

it('does not claim an empty fleet after registering a kiosk when the readiness refresh fails', async () => {
  let healthRequests = 0;
  let registered = false;
  const kiosks = pages[2];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/kiosks' && options?.method === 'POST') {
      registered = true;
      return { ok: true, json: async () => ({ id: 'new-kiosk' }) };
    }
    if (url === '/api/kiosks') return { ok: true, json: async () => [] };
    if (!url.startsWith('/api/system-health')) throw new Error(`Unexpected request ${url}`);
    healthRequests += 1;
    return healthRequests === 1
      ? { ok: true, json: async () => kiosks.emptyPayload(null) }
      : { ok: false, json: async () => ({ error: 'Refresh outage' }) };
  }));
  await act(async () => { tree = create(<KiosksPage />); });
  expect(pageText()).toContain('No kiosks are registered yet');
  const button = (label: string) => tree!.root.findAllByType('button').find(node => node.children.join('') === label)!;
  await act(async () => button('Add Kiosk').props.onClick());
  await act(async () => tree!.root.findByProps({ placeholder: 'e.g. Main Entrance Kiosk' }).props.onChange({ target: { value: 'New Kiosk' } }));
  await act(async () => button('Register Kiosk').props.onClick());
  expect(registered).toBe(true);
  expect(healthRequests).toBe(2);
  expect(pageText()).toContain('Refresh outage');
  expect(pageText()).toContain('Kiosk readiness unavailable');
  for (const claim of kiosks.emptyText) expect(pageText()).not.toContain(claim);
  expect(tileValues()).not.toContain('0');
});
