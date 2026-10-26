import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import BriefingPage from './page';
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('date=2026-10-18') }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'viewer' }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
const label = (node: any): string => typeof node === 'string' ? node : (node?.children || []).map(label).join('');
let tree: ReactTestRenderer;
afterEach(async () => { if (tree) await act(async () => tree.unmount()); vi.unstubAllGlobals(); });

function serve(kiosks: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ date: '2026-10-18', summary: { kiosk_warnings: 1 }, departments: [],
    workers: [], action_items: [], schedules: {}, kiosks: { total: 1, counts: { online: 1 }, rows: [], ...kiosks }, ...extra }) })));
}
const panel = () => label(tree.root.findByProps({ 'data-testid': 'briefing-attendance-queue' }));

it('shows the fleet-wide incomplete attendance caveat in kiosk trust', async () => {
  serve({ attendance_queue: { scope: 'current_fleet', attendance_dates_known: false, captured_at: '2026-10-18T12:00:00Z', affected_kiosks: 1,
    pending_records: 1, unknown_kiosks: 0, note: "The queued records' attendance dates are unknown.",
    kiosks: [{ id: 'k1', name: 'North gate', kiosk_id: 'north', status: 'pending', last_valid_count: 1, observed_at: '2026-10-18T11:59:00Z', caveat: true }] } });
  await act(async () => { tree = create(<BriefingPage />); });
  expect(panel()).toContain('1 kiosk last reported 1 attendance record not yet uploaded.');
  expect(panel()).toContain('attendance dates are unknown');
  expect(panel()).toContain('North gate: 1 attendance record not yet uploaded');
});

it.each([
  ['a deployment fallback', { attendance_queue: null }, { backend_unavailable: true }],
  ['an older backend', {}, {}],
])('shows unavailable queue evidence for %s', async (_label, kiosks, extra) => {
  serve(kiosks, extra);
  await act(async () => { tree = create(<BriefingPage />); });
  expect(panel()).toContain('Do not treat the queue as clear.');
});

it('keeps attendance queue evidence explicitly unavailable when the briefing request fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({ error: 'Briefing service unavailable' }) })));
  await act(async () => { tree = create(<BriefingPage />); });
  expect(label(tree.toJSON())).toContain('Briefing unavailable');
  expect(panel()).toContain('Attendance queue evidence is unavailable. Do not treat the queue as clear.');
  expect(panel()).not.toContain('No kiosk reported attendance waiting to upload.');
});
