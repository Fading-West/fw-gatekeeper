import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'viewer' }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
vi.mock('@/components/WorkerCard', () => ({ default: ({ name, status, isStale }: { name: string; status: string; isStale: boolean }) => <span>{name}|{status}|{isStale ? 'stale' : 'fresh'}</span> }));
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
it('keeps the later poll when an older request finishes and aborts on unmount', async () => {
  const visible = setupDocument();
  let resolve!: (response: Response) => void;
  const old = new Promise<Response>(yes => { resolve = yes; });
  let workers = 0; const signals: AbortSignal[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
    signals.push(init.signal as AbortSignal);
    if (url.includes('/api/workers') && ++workers === 1) return old;
    return Promise.resolve(Response.json(payload(url, 'Current synthetic')));
  }));
  await act(async () => { tree = create(<Dashboard />); });
  await act(async () => visible());
  expect(JSON.stringify(tree!.toJSON())).toContain('Current synthetic');
  expect(signals[0].aborted).toBe(true);
  await act(async () => resolve(Response.json(payload('/api/workers', 'Old synthetic'))));
  expect(JSON.stringify(tree!.toJSON())).not.toContain('Old synthetic');
  await act(async () => tree!.unmount()); tree = undefined;
  expect(signals.at(-1)?.aborted).toBe(true);
});
it('does not reuse yesterday attendance after a midnight refresh failure', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-03T04:59:58Z'));
  const visible = setupDocument(); let nextDay = false;
  const yesterday = [{ id: 'old', worker_id: 'synthetic', event_type: 'clock_in', timestamp: '2026-10-02T20:00:00' }];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => nextDay && url.includes('/api/attendance') ? Response.json({ error: 'synthetic unavailable' }, { status: 503 }) : Response.json(payload(url, 'Synthetic worker', yesterday))));
  await act(async () => { tree = create(<Dashboard />); });
  expect(JSON.stringify(tree!.toJSON())).toContain('Synthetic worker|in|fresh');
  nextDay = true; vi.setSystemTime(new Date('2026-10-03T05:00:02Z'));
  await act(async () => visible());
  expect(JSON.stringify(tree!.toJSON())).not.toContain('Synthetic worker|in|');
  expect(JSON.stringify(tree!.toJSON())).toContain('Synthetic worker|absent|stale');
});
