import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import LogPage from './log/page';
import BriefingPage from './briefing/page';
import ExceptionsPage from './exceptions/page';
import CloseoutPage from './closeout/page';

const navigation = vi.hoisted(() => ({ query: '' }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(navigation.query) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'admin' }));
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
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // America/Chicago midnight, while UTC is already on October 12.
  vi.setSystemTime(new Date('2026-10-12T04:59:59Z'));
  vi.stubGlobal('document', { activeElement: null });
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
  vi.setSystemTime(new Date('2026-10-12T05:00:01Z'));
  const value = name === 'Briefing' ? 'late' : 'Unsaved reason!';
  await editDraft(name, value);
  expect(dateInput().props.value).toBe('2026-09-14');
  expect(draftValue(name)).toBe(value);
  if (name === 'Exceptions') expect(tree!.root.findAllByType('textarea')[0].props.value).toBe('Unsaved review note');
  expect(vi.mocked(fetch).mock.calls).toHaveLength(reads);
});

it.each(pages)('$name keeps the initial factory day and draft without a manual date selection, then uses today on a new visit', async ({ name, Page }) => {
  await act(async () => { tree = create(<Page />); });
  await openDraft(name);
  await editDraft(name, name === 'Briefing' ? 'missing' : 'Unsaved reason');
  vi.setSystemTime(new Date('2026-10-12T05:00:01Z'));
  const value = name === 'Briefing' ? 'late' : 'Unsaved reason!';
  await editDraft(name, value);
  expect(dateInput().props.value).toBe('2026-10-11');
  expect(draftValue(name)).toBe(value);
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
