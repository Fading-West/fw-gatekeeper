import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/convex', () => ({ default: { query: vi.fn().mockRejectedValue(new Error('PRIVATE_BACKEND_FAILURE')) } }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: vi.fn().mockResolvedValue(true) }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'viewer' }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
vi.mock('@/components/WorkerCard', () => ({ default: () => null }));
vi.mock('@/lib/proactive-actions', () => ({ buildProactiveActions: () => [], buildLiveShiftSentinelItems: () => [], getLiveShiftSentinelSnapshot: () => ({}) }));
import Dashboard from './page';
import { GET as getWorkers } from './api/workers/route';

let tree: ReactTestRenderer | undefined;
afterEach(async () => {
  if (tree) await act(async () => tree!.unmount());
  tree = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('shows a readable roster outage from the actual route response', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('document', { hidden: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/workers')) {
      // Match Next's empty 500 when a route handler throws, so this also
      // reproduces the dashboard's parser error on the original handler.
      return getWorkers(new NextRequest(`https://example.test${url}`))
        .catch(() => new Response(null, { status: 500 }));
    }
    if (url.includes('/api/attendance')) return Response.json([]);
    if (url.includes('/api/stats')) return Response.json({ totalWorkers: 1, clockedIn: 0, clockedOut: 0, notArrived: 1, avgArrival: null });
    if (url.includes('/api/system-health')) return Response.json({
      checked_at: '2026-10-30T08:00:00Z', portal: { status: 'online' },
      face_service: { status: 'online', model_ready: true },
      kiosks: { total: 0, counts: { online: 0, offline: 0, stale: 0, never_synced: 0 }, rows: [] },
      sync: {}, warnings: [],
    });
    return Response.json({ exceptions: [], summary: { open: 0 }, blockers: [] });
  }));

  await act(async () => { tree = create(<Dashboard />); });
  const rendered = JSON.stringify(tree!.toJSON());
  expect(rendered).toContain('Worker roster could not refresh: Failed to load workers');
  expect(rendered).not.toMatch(/JSON|Unexpected end|PRIVATE_BACKEND_FAILURE/);
});
