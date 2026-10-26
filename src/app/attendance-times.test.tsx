import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import WorkerCard from '@/components/WorkerCard';
import Dashboard from './page';
import ShiftBriefingPage from './briefing/page';
import LogPage from './log/page';
import KiosksPage from './kiosks/page';

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
  ['UTC', '2026-11-01T01:15:00', '2026-11-01T07:15:00Z', '2026-11-01', 'Nov 1, 1:15 AM', '01:15 AM', '01:15:00 AM'],
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
  const health = {
    checked_at: now, face_service: { status: 'online', model_ready: true }, warnings: [],
    kiosks: { total: 1, counts: { online: 1, stale: 0, offline: 0, never_synced: 0 }, rows: [
      { id: 'entry', name: 'Entry', status: 'online', last_sync: now, last_attendance_upload: timestampUtc || timestamp },
    ] }, sync: { ready_worker_count: 1 },
  };
  const exception = {
    key: 'late', date, type: 'late_arrival', status: 'open', severity: 'warning',
    title: 'Worker arrived late', description: 'Review arrival', worker_id: 'worker', worker_name: 'Worker',
    first_seen: timestamp, last_seen: timestamp, last_seen_utc: timestampUtc, links: {},
    suggested_resolution: { action: 'review_only', can_apply: false, label: 'Review arrival', reason: 'Late arrival' },
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
      '/api/system-health': health,
      '/api/shift-exceptions': { date, exceptions: [exception], summary: { open: 1, total: 1, critical: 0 } },
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
  const kioskHealth = dashboard.root.findAllByType('p').find(node => text(node).includes('Last upload'))!;
  expect(text(kioskHealth)).toContain('Last upload 1h ago');
  const exceptionCard = dashboard.root.findAllByType('article').find(node => text(node).includes('Worker arrived late'))!;
  expect(text(exceptionCard)).toContain('1h ago');

  let kiosks!: ReactTestRenderer;
  await act(async () => { kiosks = create(<KiosksPage />); trees.push(kiosks); });
  const upload = kiosks.root.findAllByType('div').find(node => node.findAllByType('p').length === 2 && text(node).includes('Last attendance upload'))!;
  expect(text(upload.findAllByType('p')[1])).toBe(dateTime);
});

it.each([
  ['2026-09-15T09:00:00', '2026-09-15T15:00:00Z', '1h ago', '2026-09-15T08:00:00', '2026-09-15T13:00:00Z'],
  ['2026-03-08T02:30:00', '2026-03-08T09:00:00Z', 'Unknown', '2026-03-08T01:59:00', '2026-03-08T07:59:00Z'],
])('resolves a legacy exception age from its last evidence (%s)', async (lastSeen, now, expectedAge, firstSeen, firstSeenUtc) => {
  vi.stubEnv('TZ', 'UTC');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now));
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const exception = {
    key: 'legacy', date: lastSeen.slice(0, 10), type: 'late_arrival', status: 'open', severity: 'warning',
    title: 'Legacy arrival', description: 'Review arrival', links: {},
    first_seen: firstSeen, first_seen_utc: firstSeenUtc, last_seen: lastSeen,
    suggested_resolution: { action: 'review_only', can_apply: false, label: 'Review arrival', reason: 'Late arrival' },
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: url.startsWith('/api/shift-exceptions'), status: 503,
    json: async () => url.startsWith('/api/shift-exceptions')
      ? { exceptions: [exception], summary: { open: 1, total: 1, critical: 0 } } : { error: 'Unavailable' },
  })));
  let dashboard!: ReactTestRenderer;
  await act(async () => { dashboard = create(<Dashboard />); trees.push(dashboard); });
  const card = dashboard.root.findAllByType('article').find(node => text(node).includes('Legacy arrival'))!;
  expect(text(card.findAllByType('span').at(-1)!)).toBe(expectedAge);
});
