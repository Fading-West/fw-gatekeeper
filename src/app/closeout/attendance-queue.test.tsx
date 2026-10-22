import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import CloseoutPage from './page';
import { describeAttendanceQueue } from '@/components/AttendanceQueueEvidence';
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('date=2026-10-18') }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'enrollment' }));
vi.mock('@/hooks/useCloseoutActor', () => ({ useCloseoutActor: () => 'synthetic-queue-actor' }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
const label = (node: any): string => typeof node === 'string' ? node : (node?.children || []).map(label).join('');
let tree: ReactTestRenderer;
afterEach(async () => { if (tree) await act(async () => tree.unmount()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const note = "This is current fleet-wide uncertainty: the queued records' attendance dates are unknown, so they are not assigned to this shift.";
const evidence = (count: number, status: 'pending' | 'clear' | 'unknown' = count ? 'pending' : 'clear') => ({
  scope: 'current_fleet', attendance_dates_known: false, captured_at: '2026-10-18T22:00:00.000Z', note,
  affected_kiosks: count ? 1 : 0, pending_records: count, unknown_kiosks: status === 'unknown' ? 1 : 0,
  kiosks: count || status === 'unknown' ? [{ id: 'kiosk-1', name: 'North gate', kiosk_id: 'north', status, last_valid_count: count, observed_at: '2026-10-18T21:59:00.000Z', caveat: count > 0 }] : [],
});
function serve(payload: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ date: '2026-10-18', blocker_evidence: 'evidence',
    summary: { kiosk_warnings: 0 }, checklist: [], blockers: [], action_links: [], can_complete: true, ...payload }) })));
}
const panel = (id: string) => label(tree.root.findByProps({ 'data-testid': id }));

it('shows the current fleet-wide caveat without a signed panel on an open record', async () => {
  serve({ closeout: null, attendance_queue: evidence(237), summary: { kiosk_warnings: 1 }, can_complete: false });
  await act(async () => { tree = create(<CloseoutPage />); });
  expect(panel('current-attendance-queue')).toContain('1 kiosk last reported 237 attendance records not yet uploaded.');
  expect(panel('current-attendance-queue')).toContain('attendance dates are unknown');
  expect(panel('current-attendance-queue')).toContain('North gate: 237 attendance records not yet uploaded');
  expect(tree.root.findAllByProps({ 'data-testid': 'signed-attendance-queue' })).toHaveLength(0);
});

it('separates signed proof from current observations and marks older signatures not recorded', async () => {
  serve({ closeout: { status: 'completed', notes: 'Signed', acknowledged_blockers: true, snapshot: {}, signed_attendance_queue: null }, attendance_queue: evidence(4) });
  await act(async () => { tree = create(<CloseoutPage />); });
  expect(panel('signed-attendance-queue')).toContain('Not recorded');
  expect(panel('current-attendance-queue')).toContain('4 attendance records not yet uploaded');
});

it('exports signed and current queue evidence as separate sections', async () => {
  serve({ closeout: { status: 'completed', notes: 'Signed', acknowledged_blockers: true, snapshot: { kiosk_warnings: 1 }, signed_attendance_queue: evidence(9) }, attendance_queue: evidence(0) });
  let exported: Blob | undefined;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { exported = blob as Blob; return 'blob:synthetic'; });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.stubGlobal('document', { createElement: () => ({ click: vi.fn() }) });
  await act(async () => { tree = create(<CloseoutPage />); });
  expect(panel('signed-attendance-queue')).toContain('North gate: 9 attendance records not yet uploaded');
  expect(panel('current-attendance-queue')).toContain('No kiosk reported attendance waiting to upload.');
  await act(async () => tree.root.findAllByType('button').find(node => label(node) === 'Export')!.props.onClick());
  const text = await exported!.text();
  const signed = text.indexOf('Signed attendance queue evidence');
  const current = text.indexOf('Current attendance queue observations');
  expect(signed).toBeGreaterThan(-1);
  expect(current).toBeGreaterThan(signed);
  expect(text.slice(signed, current)).toContain('North gate (north): 9 attendance records not yet uploaded');
  expect(text.slice(current)).toContain('No kiosk reported attendance waiting to upload.');
});

it.each([
  ['deployment fallback', { backend_unavailable: true, attendance_queue: null, can_complete: false }],
  ['an older backend without queue evidence', {}],
])('never presents %s as a clear queue', async (_label, payload) => {
  serve({ closeout: null, ...payload });
  await act(async () => { tree = create(<CloseoutPage />); });
  expect(panel('current-attendance-queue')).toContain('unavailable. Do not treat the queue as clear.');
});

it('describes unknown reports with their retained observation', () => {
  expect(describeAttendanceQueue({ status: 'unknown', last_valid_count: 5, observed_at: null, caveat: true })).toContain('last valid report was 5 attendance records not yet uploaded');
  expect(describeAttendanceQueue({ status: 'unknown', last_valid_count: null, observed_at: null, caveat: false })).toBe('Queue count not reported');
  expect(describeAttendanceQueue(undefined)).toBe('Not reported by this backend');
});
