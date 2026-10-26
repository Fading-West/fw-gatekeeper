import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Dashboard from './page';

vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'admin' }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));

let tree: ReactTestRenderer | undefined;
let issues: string[];
let briefingMode: 'error' | 'fallback';
let kioskStatus: 'online' | 'stale' | 'offline';
let refresh: () => void;

beforeEach(() => {
  issues = [];
  briefingMode = 'error';
  kioskStatus = 'online';
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('document', {
    hidden: false,
    addEventListener: (event: string, handler: () => void) => { if (event === 'visibilitychange') refresh = handler; },
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/workers')) return Response.json([
      { id: 'worker', name: 'Synthetic worker', department: 'Mill', encoding_status: 'valid' },
    ]);
    if (url.startsWith('/api/attendance')) return Response.json([]);
    if (url.startsWith('/api/stats')) return Response.json({ totalWorkers: 1, clockedIn: 0, clockedOut: 0, notArrived: 1, avgArrival: null });
    if (url.startsWith('/api/system-health')) return Response.json({
      checked_at: '2026-10-25T12:00:00Z',
      face_service: { status: 'online', model_ready: true },
      kiosks: {
        total: 1,
        counts: { online: Number(kioskStatus === 'online'), stale: Number(kioskStatus === 'stale'), offline: Number(kioskStatus === 'offline'), never_synced: 0 },
        rows: [{ id: 'kiosk', name: 'Synthetic gate', status: kioskStatus, device_issues: issues }],
      },
      warnings: issues.map(issue => `Kiosk Synthetic gate: ${issue}`),
    });
    if (url.startsWith('/api/shift-briefing')) return briefingMode === 'error'
      ? Response.json({ error: 'Briefing unavailable' }, { status: 503 })
      : Response.json({ backend_unavailable: true, warning: 'Briefing storage unavailable' });
    return Response.json({ backend_unavailable: true, exceptions: [], summary: { open: 0 }, blockers: [] });
  }));
});

afterEach(async () => {
  if (tree) await act(async () => tree!.unmount());
  tree = undefined;
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () => { tree = create(<Dashboard />); });
}

function readinessPanel() {
  const heading = tree!.root.findAllByType('h2').find(node => node.children.join('').includes('shift trust'))!;
  const section = heading.parent!.parent!.parent!.parent!;
  // Inspect the actual readiness panel, independently of timeline warnings.
  expect(section.type).toBe('section');
  const text = (node: ReactTestInstance | string): string => typeof node === 'string' ? node : node.children.map(text).join('');
  return text(section);
}

it.each(['error', 'fallback'] as const)('does not declare shift readiness with a syncing broken camera when briefing returns %s', async mode => {
  briefingMode = mode;
  issues = ['camera failure — the kiosk cannot scan'];
  await mount();
  expect(readinessPanel()).toContain('Needs attention before shift');
  expect(readinessPanel()).not.toContain('Ready for shift');
  expect(readinessPanel()).not.toContain('Ready shift trust');
});

it.each([
  'recognition model failed to load — all scans are rejected',
  'required blink verification unavailable — automatic attendance is paused; restore the landmark model or contact a supervisor',
  '2 attendance records queued on-device',
  'Biometric purge still unconfirmed on this kiosk',
])('keeps a reported device issue visible in fallback readiness: %s', async issue => {
  issues = [issue];
  await mount();
  expect(readinessPanel()).toContain('Needs attention before shift');
  expect(readinessPanel()).not.toContain('Ready for shift');
});

it('still declares healthy fallback readiness when no kiosk reports an issue', async () => {
  await mount();
  expect(readinessPanel()).toContain('Ready for shift');
});

it.each(['stale', 'offline'] as const)('preserves existing %s sync severity with a device issue', async status => {
  kioskStatus = status;
  issues = ['camera failure — the kiosk cannot scan'];
  await mount();
  expect(readinessPanel()).toContain(status === 'offline' ? 'Not ready for shift' : 'Needs attention before shift');
});

it('recovers to ready after a refresh confirms that the device issue cleared', async () => {
  issues = ['camera failure — the kiosk cannot scan'];
  await mount();
  expect(readinessPanel()).toContain('Needs attention before shift');
  issues = [];
  await act(async () => { refresh(); });
  expect(readinessPanel()).toContain('Ready for shift');
});
