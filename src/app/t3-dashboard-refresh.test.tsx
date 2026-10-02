import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'viewer' }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
vi.mock('@/components/WorkerCard', () => ({ default: ({ name, status, isStale }: { name: string; status: string; isStale: boolean }) => <span data-worker={name} data-status={status} data-stale={isStale}>{name}</span> }));
vi.mock('@/lib/proactive-actions', () => ({ buildProactiveActions: () => [], buildLiveShiftSentinelItems: () => [], getLiveShiftSentinelSnapshot: () => ({}) }));
import Dashboard from './page';
let tree: ReactTestRenderer | undefined;
afterEach(async () => { if (tree) await act(async () => tree!.unmount()); tree = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });
function setupDocument() {
  let visible!: () => void;
  vi.stubGlobal('document', { hidden: false, addEventListener: (name: string, handler: () => void) => { if (name === 'visibilitychange') visible = handler; }, removeEventListener: vi.fn() });
  return () => visible();
}
function payload(url: string, workerName: string, attendance: unknown[] = []) {
  if (url.includes('/api/workers')) return [{ id: 'synthetic', name: workerName, department: 'Synthetic', has_face_encoding: true }];
  if (url.includes('/api/attendance')) return attendance;
  if (url.includes('/api/stats')) return { totalWorkers: 1, clockedIn: 0, clockedOut: 0, notArrived: 1, avgArrival: null };
  if (url.includes('/api/system-health')) return { checked_at: '2026-10-02T08:00:00Z', portal: { status: 'online' }, face_service: { status: 'online', model_ready: true }, kiosks: { total: 0, counts: { online: 0, offline: 0, stale: 0, never_synced: 0 }, rows: [] }, sync: {}, warnings: [] };
  return { backend_unavailable: true, exceptions: [], summary: { open: 0 }, blockers: [] };
}
it('aborts the pending older workers read and keeps the later visibility refresh result', async () => {
  const visible = setupDocument();
  let resolve!: (response: Response) => void;
  const old = new Promise<Response>(yes => { resolve = yes; });
  let workers = 0;
  let oldWorkerSignal!: AbortSignal;
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
    if (url.includes('/api/workers') && ++workers === 1) {
      oldWorkerSignal = init.signal as AbortSignal;
      return old;
    }
    return Promise.resolve(Response.json(payload(url, 'Current synthetic')));
  }));
  await act(async () => { tree = create(<Dashboard />); });
  expect(oldWorkerSignal.aborted).toBe(false);
  await act(async () => visible());
  expect(JSON.stringify(tree!.toJSON())).toContain('Current synthetic');
  expect(oldWorkerSignal.aborted).toBe(true);
  await act(async () => resolve(Response.json(payload('/api/workers', 'Old synthetic'))));
  expect(JSON.stringify(tree!.toJSON())).not.toContain('Old synthetic');
  await act(async () => tree!.unmount()); tree = undefined;
});
it('does not reuse yesterday attendance after a midnight refresh failure', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-03T04:59:58Z'));
  const visible = setupDocument(); let nextDay = false;
  const yesterday = [{ id: 'old', worker_id: 'synthetic', event_type: 'clock_in', timestamp: '2026-10-02T20:00:00' }];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => nextDay && url.includes('/api/attendance') ? Response.json({ error: 'synthetic unavailable' }, { status: 503 }) : Response.json(payload(url, 'Synthetic worker', yesterday))));
  await act(async () => { tree = create(<Dashboard />); });
  expect(tree!.root.findByProps({ 'data-worker': 'Synthetic worker' }).props).toMatchObject({ 'data-status': 'in', 'data-stale': false });
  nextDay = true; vi.setSystemTime(new Date('2026-10-03T05:00:02Z'));
  await act(async () => visible());
  expect(tree!.root.findByProps({ 'data-worker': 'Synthetic worker' }).props).toMatchObject({ 'data-status': 'absent', 'data-stale': true });
});

it('lets a twelve-second batch finish despite automatic ten-second polls', async () => {
  vi.useFakeTimers(); setupDocument();
  let workerRequests = 0;
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.includes('/api/workers')) {
      workerRequests++;
      return new Promise<Response>(resolve => setTimeout(() => resolve(Response.json(payload(url, 'Slow worker'))), 12_000));
    }
    return Promise.resolve(Response.json(payload(url, 'Slow worker')));
  }));
  await act(async () => { tree = create(<Dashboard />); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(workerRequests).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  expect(tree!.root.findByProps({ 'data-worker': 'Slow worker' })).toBeTruthy();
});
it('publishes healthy signals after one hung response times out', async () => {
  vi.useFakeTimers(); setupDocument();
  vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('/api/attendance')
    ? new Promise<Response>(() => {}) : Promise.resolve(Response.json(payload(url, 'Available worker')))));
  await act(async () => { tree = create(<Dashboard />); });
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(tree!.root.findByProps({ 'data-worker': 'Available worker' }).props['data-stale']).toBe(true);
  expect(JSON.stringify(tree!.toJSON())).toContain('timed out');
});
it('aborts a pending read on unmount without cancelling already completed reads', async () => {
  setupDocument();
  const reads: { url: string; signal: AbortSignal }[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
    reads.push({ url, signal: init.signal as AbortSignal });
    return url.includes('/api/attendance') ? new Promise<Response>(() => {})
      : Promise.resolve(Response.json(payload(url, 'Synthetic worker')));
  }));
  await act(async () => { tree = create(<Dashboard />); });
  expect(reads).toHaveLength(7);
  const pending = reads.find(read => read.url.includes('/api/attendance'))!;
  expect(pending.signal.aborted).toBe(false);
  await act(async () => tree!.unmount()); tree = undefined;
  expect(pending.signal.aborted).toBe(true);
  expect(reads.filter(read => read !== pending).every(read => !read.signal.aborted)).toBe(true);
});
