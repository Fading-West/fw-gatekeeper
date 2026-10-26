import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import LogPage from './log/page';
import BriefingPage from './briefing/page';
import ExceptionsPage from './exceptions/page';
import CloseoutPage from './closeout/page';

const navigation = vi.hoisted(() => ({ query: '' }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(navigation.query) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'admin' }));
vi.mock('@/hooks/useCloseoutActor', () => ({ useCloseoutActor: () => 'synthetic-actor' }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/AttendanceTable', () => ({ default: () => null, attendanceRowId: (id: string) => id }));

const pages = [
  { name: 'Log', Page: LogPage },
  { name: 'Briefing', Page: BriefingPage },
  { name: 'Exceptions', Page: ExceptionsPage },
  { name: 'Closeout', Page: CloseoutPage },
];
let tree: ReactTestRenderer | undefined;
const dateInput = () => tree!.root.findAllByType('input').find((node) => node.props.type === 'date')!;

beforeEach(() => {
  navigation.query = '';
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // America/Chicago midnight, while UTC is already on October 12.
  vi.setSystemTime(new Date('2026-10-12T04:59:59Z'));
  vi.stubGlobal('document', { activeElement: null, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('HTMLElement', class {});
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const date = new URL(url, 'http://localhost').searchParams.get('date');
    let payload: unknown = [];
    if (url.startsWith('/api/attendance-corrections')) {
      payload = { corrections: [{
        id: 'correction-1', date, worker_id: 'worker-1', worker_name: 'Worker', worker_department: 'Assembly',
        action: 'add_clock_in', event_type: 'clock_in', corrected_timestamp: `${date}T08:00:00`,
        reason: 'Missed scan', supervisor_name: 'Supervisor', created_at: `${date}T08:00:00`,
      }] };
    } else if (url.startsWith('/api/shift-briefing')) {
      payload = { date, summary: {}, departments: [], workers: [], action_items: [], schedules: {}, kiosks: { counts: {} } };
    } else if (url.startsWith('/api/shift-exceptions')) {
      payload = { date, summary: {}, exceptions: [{
        key: 'missing-worker', date, worker_id: 'worker-1', worker_name: 'Worker', department: 'Assembly',
        type: 'missing_arrival', severity: 'warning', status: 'open', links: {}, title: 'Missed scan',
        suggested_resolution: { can_apply: true, action: 'add_clock_in', corrected_time: '08:00',
          source_exception_key: 'missing-worker', reason: 'Verified arrival', label: 'Add clock-in', cta: 'Correct scan' },
      }] };
    } else if (url.startsWith('/api/shift-closeout')) {
      payload = { date, closeout: null, summary: {}, checklist: [], blockers: [], action_links: [], can_complete: true };
    }
    return { ok: true, json: async () => payload };
  }));
});

afterEach(async () => {
  if (tree) await act(async () => tree!.unmount());
  tree = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function openDraft(name: string) {
  if (name === 'Exceptions') {
    await act(async () => tree!.root.findByType('textarea').props.onChange({ target: { value: 'Unsaved review note' } }));
  }
  if (name === 'Log' || name === 'Exceptions') {
    const label = name === 'Log' ? 'Reverse' : 'Correct scan';
    await act(async () => tree!.root.findAllByType('button').find((node) => node.children.includes(label))!.props.onClick());
  }
}

async function editDraft(name: string, value: string) {
  await act(async () => {
    if (name === 'Briefing') {
      tree!.root.findAllByType('select')[1].props.onChange({ target: { value } });
    } else {
      tree!.root.findAllByType('textarea').at(-1)!.props.onChange({ target: { value } });
    }
  });
}

function draftValue(name: string) {
  return name === 'Briefing'
    ? tree!.root.findAllByType('select')[1].props.value
    : tree!.root.findAllByType('textarea').at(-1)?.props.value;
}

it.each(pages)('$name preserves a historical date and unsaved work when typing after factory midnight', async ({ name, Page }) => {
  await act(async () => { tree = create(<Page />); });
  expect(dateInput().props.value).toBe('2026-10-11');
  await act(async () => dateInput().props.onChange({ target: { value: '2026-09-14' } }));
  await openDraft(name);
  await editDraft(name, name === 'Briefing' ? 'missing' : 'Unsaved reason');
  const reads = vi.mocked(fetch).mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  const value = name === 'Briefing' ? 'late' : 'Unsaved reason!';
  await editDraft(name, value);
  expect(dateInput().props.value).toBe('2026-09-14');
  expect(draftValue(name)).toBe(value);
  expect(tree!.root.findByProps({ role: 'status' }).children.join('')).toContain('A new factory day has started');
  if (name === 'Exceptions') expect(tree!.root.findAllByType('textarea')[0].props.value).toBe('Unsaved review note');
  expect(vi.mocked(fetch).mock.calls).toHaveLength(reads);
});

it.each(pages.filter(({ name }) => name !== 'Briefing'))('$name keeps the initial factory day and draft without a manual date selection, then uses today on a new visit', async ({ name, Page }) => {
  await act(async () => { tree = create(<Page />); });
  await openDraft(name);
  await editDraft(name, name === 'Briefing' ? 'missing' : 'Unsaved reason');
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  const value = name === 'Briefing' ? 'late' : 'Unsaved reason!';
  await editDraft(name, value);
  expect(dateInput().props.value).toBe('2026-10-11');
  expect(draftValue(name)).toBe(value);
  expect(tree!.root.findByProps({ role: 'status' }).children.join('')).toContain('2026-10-12');
  if (name === 'Exceptions') expect(tree!.root.findAllByType('textarea')[0].props.value).toBe('Unsaved review note');
  await act(async () => { tree!.unmount(); });
  await act(async () => { tree = create(<Page />); });
  expect(dateInput().props.value).toBe('2026-10-12');
});

it.each(pages)('$name syncs URL date changes but preserves a manual date on unrelated URL changes', async ({ Page }) => {
  await act(async () => { tree = create(<Page />); });
  await act(async () => dateInput().props.onChange({ target: { value: '2026-09-14' } }));
  navigation.query = 'department=Assembly';
  await act(async () => tree!.update(<Page />));
  expect(dateInput().props.value).toBe('2026-09-14');
  navigation.query = 'department=Assembly&date=2026-09-15';
  await act(async () => tree!.update(<Page />));
  expect(dateInput().props.value).toBe('2026-09-15');
  navigation.query = '';
  await act(async () => tree!.update(<Page />));
  expect(dateInput().props.value).toBe('2026-10-11');
});

for (const midnight of [
  { before: '2026-10-12T04:59:59Z', oldDay: '2026-10-11', today: '2026-10-12' },
  // Midnight at the start of the spring DST transition (CST).
  { before: '2026-03-08T05:59:59Z', oldDay: '2026-03-07', today: '2026-03-08' },
  // Midnight after the fall DST transition: the preceding day had 25 hours.
  { before: '2026-11-02T05:59:59Z', oldDay: '2026-11-01', today: '2026-11-02' },
]) {
  it.each(pages.filter(({ name }) => name !== 'Closeout'))(`$name automatically refreshes an untouched default view at Chicago midnight on ${midnight.today}`, async ({ Page }) => {
    vi.setSystemTime(new Date(midnight.before));
    await act(async () => { tree = create(<Page />); });
    expect(dateInput().props.value).toBe(midnight.oldDay);
    const reads = vi.mocked(fetch).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(dateInput().props.value).toBe(midnight.today);
    expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(reads);
    expect(vi.mocked(fetch).mock.calls.slice(reads).every(([url]) => String(url).includes(`date=${midnight.today}`))).toBe(true);
    expect(tree!.root.findAllByProps({ role: 'status' })).toHaveLength(0);
  });

  it(`keeps Closeout signoff on its day with a visible notice at Chicago midnight on ${midnight.today}`, async () => {
    vi.setSystemTime(new Date(midnight.before));
    await act(async () => { tree = create(<CloseoutPage />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(dateInput().props.value).toBe(midnight.oldDay);
    expect(tree!.root.findByProps({ role: 'status' }).children.join('')).toContain(midnight.today);
  });
}

it('rolls Briefing over without resetting the supervisor’s status filter', async () => {
  await act(async () => { tree = create(<BriefingPage />); });
  await editDraft('Briefing', 'missing');
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(dateInput().props.value).toBe('2026-10-12');
  expect(draftValue('Briefing')).toBe('missing');
});

it.each(pages)('$name honours URL back/forward, including an explicit date equal to the previous default', async ({ Page }) => {
  await act(async () => { tree = create(<Page />); });
  await act(async () => dateInput().props.onChange({ target: { value: '2026-09-14' } }));
  navigation.query = 'date=2026-10-11';
  await act(async () => tree!.update(<Page />));
  expect(dateInput().props.value).toBe('2026-10-11');
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(dateInput().props.value).toBe('2026-10-11');
  navigation.query = '';
  await act(async () => tree!.update(<Page />));
  expect(dateInput().props.value).toBe('2026-10-12');
  navigation.query = 'date=2026-10-11';
  await act(async () => tree!.update(<Page />));
  expect(dateInput().props.value).toBe('2026-10-11');
});

it.each(pages.filter(({ name }) => name === 'Log' || name === 'Exceptions'))('$name keeps an open editor even before typing', async ({ name, Page }) => {
  await act(async () => { tree = create(<Page />); });
  await openDraft(name);
  const value = draftValue(name);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(dateInput().props.value).toBe('2026-10-11');
  expect(draftValue(name)).toBe(value);
});

it('catches up an untouched page immediately when a sleeping tab becomes visible', async () => {
  await act(async () => { tree = create(<BriefingPage />); });
  const checkDay = vi.mocked(document.addEventListener).mock.calls.find(([event]) => event === 'visibilitychange')![1] as () => void;
  vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
  await act(async () => checkDay());
  expect(dateInput().props.value).toBe('2026-10-13');
});

it.each(pages)('$name has clock-independent SSR markup and opens on the current factory day after hydration', async ({ Page }) => {
  const before = renderToString(<Page />);
  expect(before).not.toContain('2026-10-11');
  expect(before).not.toContain('type="date"');
  vi.setSystemTime(new Date('2026-10-12T05:00:01Z'));
  expect(renderToString(<Page />)).toBe(before);
  await act(async () => { tree = create(<Page />); });
  expect(dateInput().props.value).toBe('2026-10-12');
});

it.each(pages)('$name preserves a historical selection and work across midnight after the 25-hour Chicago DST day', async ({ name, Page }) => {
  vi.setSystemTime(new Date('2026-11-02T05:59:59Z'));
  await act(async () => { tree = create(<Page />); });
  expect(dateInput().props.value).toBe('2026-11-01');
  await act(async () => dateInput().props.onChange({ target: { value: '2026-09-14' } }));
  await openDraft(name);
  const value = name === 'Briefing' ? 'missing' : 'Unsaved DST reason';
  await editDraft(name, value);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(dateInput().props.value).toBe('2026-09-14');
  expect(draftValue(name)).toBe(value);
  expect(tree!.root.findByProps({ role: 'status' }).children.join('')).toContain('2026-11-02');
});
