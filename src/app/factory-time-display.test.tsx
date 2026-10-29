import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import KiosksPage from './kiosks/page';
import BriefingPage from './briefing/page';
import { attendanceQueueExportLines } from '@/components/AttendanceQueueEvidence';
import type { AttendanceQueueEvidence } from '@/lib/types';
import { buildProactiveActions } from '@/lib/proactive-actions';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('date=2026-10-29') }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'viewer' }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const text = (node: ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(text).join('').replace(/\s+/g, ' ');
const instant = '2026-10-29T15:00:00.000Z'; // 10:00 AM in the factory (America/Chicago)
const factory = 'Oct 29, 10:00 AM';
const queue: AttendanceQueueEvidence = {
  scope: 'current_fleet', attendance_dates_known: false, captured_at: instant, note: 'Fleet-wide.',
  affected_kiosks: 1, pending_records: 3, unknown_kiosks: 0,
  kiosks: [{ id: 'k', name: 'Front', kiosk_id: 'k', status: 'pending', last_valid_count: 3, observed_at: instant, caveat: false }],
};

let tree: ReactTestRenderer | null = null;
afterEach(async () => {
  if (tree) await act(async () => tree!.unmount());
  tree = null;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each(['America/Los_Angeles', 'UTC'])('shows kiosk, queue, briefing and closeout instants in factory time for a %s viewer', async (timezone) => {
  vi.stubEnv('TZ', timezone);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.startsWith('/api/system-health') ? {
    kiosks: { total: 1, counts: { online: 1, stale: 0, offline: 0, never_synced: 0 }, rows: [{ id: 'k', name: 'Front', kiosk_id: 'k', status: 'online',
      last_sync: instant, roster_applied_at: instant, last_attendance_upload: instant, expected_worker_count: 1, attendance_queue: queue.kiosks[0] }] },
    sync: { ready_worker_count: 1 },
  } : [{ id: 'k', credential_status: 'active' }] })));
  await act(async () => { tree = create(<KiosksPage />); });
  const field = (label: string) => text(tree!.root.findAll(node => node.type === 'p' && node.children[0] === label)[0].parent!.findAllByType('p')[1]);
  expect(field('Last contact')).toBe(factory);
  expect(field('Last applied roster')).toBe(factory);
  expect(field('Last attendance upload')).toBe(factory);
  expect(field('Attendance not yet uploaded')).toBe(`3 attendance records not yet uploaded (reported ${factory})`);
  await act(async () => tree!.unmount());

  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ date: '2026-10-29', generated_at: instant, summary: { kiosk_warnings: 1 },
    departments: [], workers: [], action_items: [], schedules: { active_today: 1 }, kiosks: { total: 1, counts: { online: 1 }, rows: [], attendance_queue: queue } }) })));
  await act(async () => { tree = create(<BriefingPage />); });
  expect(text(tree!.root)).toContain(`Generated ${factory}`);
  expect(text(tree!.root.findByProps({ 'data-testid': 'briefing-attendance-queue' }))).toContain(`(reported ${factory})`);

  expect(attendanceQueueExportLines(queue, 'missing')[0].replace(/\s+/g, ' ')).toBe(`Captured: ${factory}`);
  const closeout = buildProactiveActions({ date: '2026-10-29', shiftCloseout: { closeout: { status: 'completed', completed_at: instant } } })
    .find(action => action.key === 'shift-closeout-complete')!;
  expect(closeout.description.replace(/\s+/g, ' ')).toBe("Today's supervisor closeout was completed at 10:00 AM.");
});
