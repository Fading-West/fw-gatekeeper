import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import WorkerCard from '@/components/WorkerCard';
import Dashboard from './page';
import ShiftBriefingPage from './briefing/page';
import LogPage from './log/page';

const selection = vi.hoisted(() => ({ date: '' }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams({ date: selection.date }) }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'viewer' }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

function text(node: ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(text).join('').replace(/\s+/g, ' ');
}

const trees: ReactTestRenderer[] = [];
afterEach(async () => {
  await act(async () => { for (const tree of trees.splice(0)) tree.unmount(); });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it.each([
  ['UTC', '2026-09-15T13:00:00Z', '2026-09-15T14:00:00Z', '2026-09-15', 'Sep 15, 8:00 AM', '08:00 AM', '08:00:00 AM'],
  ['Asia/Tokyo', '2026-09-15T15:00:00+02:00', '2026-09-15T14:00:00Z', '2026-09-15', 'Sep 15, 8:00 AM', '08:00 AM', '08:00:00 AM'],
  ['Europe/Paris', '2026-03-29T02:30:00', '2026-03-29T08:30:00Z', '2026-03-29', 'Mar 29, 2:30 AM', '02:30 AM', '02:30:00 AM'],
  ['Asia/Tokyo', '2026-09-16T02:00:00Z', '2026-09-16T03:00:00Z', '2026-09-15', 'Sep 15, 9:00 PM', '09:00 PM', '09:00:00 PM'],
  ['UTC', '2026-12-15T14:00:00Z', '2026-12-15T15:00:00Z', '2026-12-15', 'Dec 15, 8:00 AM', '08:00 AM', '08:00:00 AM'],
  ['Europe/Paris', '2026-03-08T08:01:00Z', '2026-03-08T09:01:00Z', '2026-03-08', 'Mar 8, 3:01 AM', '03:01 AM', '03:01:00 AM'],
  ['Asia/Tokyo', '2026-11-01T01:15:00', '2026-11-01T08:15:00Z', '2026-11-01', 'Nov 1, 1:15 AM', '01:15 AM', '01:15:00 AM', '2026-11-01T07:15:00Z'],
])('keeps punch displays and ages in factory time for a %s viewer (%s)', async (timezone, timestamp, now, date, dateTime, time, timeWithSeconds, timestampUtc?: string) => {
  vi.stubEnv('TZ', timezone);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now));
  selection.date = date;
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() });

  const event = {
    id: 'scan', worker_id: 'worker', worker_name: 'Worker', worker_department: 'Assembly',
    timestamp, timestamp_utc: timestampUtc, event_type: 'clock_in', kiosk_id: 'entry', kiosk_name: 'Entry', synced: 1,
  };
  const correction = { id: 'void', date, worker_id: 'worker', worker_name: 'Worker', action: 'void_event',
    original_timestamp: timestamp, corrected_timestamp: null, created_at: now, reason: 'Duplicate scan' };
  const briefing = {
    date, generated_at: now, summary: { expected: 1, present: 1 }, departments: [], action_items: [],
    workers: [{ worker_id: 'worker', worker_name: 'Worker', department: 'Assembly', schedule_name: 'Day',
      status: 'present', first_seen: timestamp, last_seen: timestamp, event_count: 1 }],
    kiosks: { total: 0, counts: {}, rows: [] }, schedules: { active_today: 1, total_active: 1 },
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = url.split('?')[0];
    const responses: Record<string, unknown> = {
      '/api/attendance': [event],
      '/api/attendance-corrections': { corrections: [
        correction,
        { ...correction, id: 'added', action: 'add_clock_in', corrected_timestamp: timestamp, original_timestamp: null },
        { ...correction, id: 'fallback', original_timestamp: null, created_at: timestamp,
          reversal_id: 'reversal', reversal_reason: 'Wrong worker', reversed_at: timestamp },
      ] },
      '/api/workers': [{ id: 'worker', name: 'Worker', department: 'Assembly' }],
      '/api/stats': { totalWorkers: 1, clockedIn: 1, clockedOut: 0, notArrived: 0, avgArrival: null },
      '/api/shift-briefing': briefing,
    };
    return { ok: path in responses, json: async () => responses[path] || {} };
  }));

  let log!: ReactTestRenderer;
  await act(async () => { log = create(<LogPage />); trees.push(log); });
  const rows = log.root.findAllByType('tr').filter(row => row.findAllByType('td').length);
  expect(text(rows[0].findAllByType('td')[0])).toBe(timeWithSeconds);
  for (const row of rows.slice(1)) expect(text(row.findAllByType('td')[2])).toBe(dateTime);
  expect(text(rows[3].findAllByType('td')[3])).toContain(`Reversal: Wrong worker · ${dateTime}`);

  let brief!: ReactTestRenderer;
  await act(async () => { brief = create(<ShiftBriefingPage />); trees.push(brief); });
  const workerRow = brief.root.findAllByType('tr').find(row => text(row).includes('WorkerAssembly'))!;
  const briefTime = time.replace(/^0/, '');
  expect(text(workerRow.findAllByType('td')[3])).toBe(briefTime);
  expect(text(workerRow.findAllByType('td')[4])).toBe(briefTime);

  let dashboard!: ReactTestRenderer;
  await act(async () => { dashboard = create(<Dashboard />); trees.push(dashboard); });
  expect(dashboard.root.findByType(WorkerCard).props.clockInTime).toBe(time);
  const timeline = dashboard.root.findAllByType('a').find(node => text(node).includes('Worker clocked in'))!;
  expect(text(timeline)).toContain('1h ago');
});
