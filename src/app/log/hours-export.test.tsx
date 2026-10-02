import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import LogPage from './page';

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('date=2026-09-14') }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'viewer' }));
vi.mock('@/components/AttendanceTable', () => ({ default: () => null, attendanceRowId: (id: string) => id }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it.each(['Export CSV', 'Export hours CSV'])('neutralizes worker-supplied formulas in %s', async (label) => {
  const events = [
    { id: 'in', worker_id: 'worker', worker_name: '=1+1', worker_department: '+1+2', timestamp: '2026-09-14T08:00:00', event_type: 'clock_in', note: '@SUM(A1:A2)' },
    { id: 'out', worker_id: 'worker', worker_name: '=1+1', worker_department: '+1+2', timestamp: '2026-09-14T16:00:00', event_type: 'clock_out' },
  ];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () =>
    url.startsWith('/api/attendance-corrections') ? { corrections: [] } : url.includes('2026-09-15') ? [] : events,
  })));
  let exported!: Blob;
  vi.stubGlobal('URL', { createObjectURL: (blob: Blob) => { exported = blob; return 'blob:test'; }, revokeObjectURL: vi.fn() });
  vi.stubGlobal('document', { createElement: () => ({ click: vi.fn() }) });
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<LogPage />); });
  try {
    const button = tree.root.findAllByType('button').find((node) => node.children.some(child => typeof child === 'string' && child.trim() === label))!;
    expect(button.props.disabled).toBe(false);
    await act(async () => button.props.onClick());
    const csv = await exported.text();
    expect(csv).toContain("'=1+1,'+1+2,");
    if (label === 'Export CSV') expect(csv).toContain("'@SUM(A1:A2)");
    else expect(csv).toContain(',8.00,');
  } finally {
    await act(async () => tree.unmount());
  }
});

it('downloads blank ambiguous hours with a review note and warns the operator', async () => {
  const event = (timestamp: string, event_type: string) => ({ id: timestamp, worker_id: 'worker', worker_name: 'Worker', worker_department: 'Assembly', timestamp, event_type });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () =>
    url.startsWith('/api/attendance-corrections') ? { corrections: [] } :
    url.includes('2026-09-15') ? [event('2026-09-15T08:00:00', 'clock_in'), event('2026-09-15T16:00:00', 'clock_out')] :
    [event('2026-09-14T08:00:00', 'clock_in')],
  })));
  let exported!: Blob;
  vi.stubGlobal('URL', { createObjectURL: (blob: Blob) => { exported = blob; return 'blob:test'; }, revokeObjectURL: vi.fn() });
  vi.stubGlobal('document', { createElement: () => ({ click: vi.fn() }) });
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<LogPage />); });
  try {
    const button = tree.root.findAllByType('button').find((node) => node.children.includes('Export hours CSV'))!;
    expect(button.props.disabled).toBe(false);
    await act(async () => button.props.onClick());
    expect(await exported.text()).toBe('Worker,Department,First In,Last Out,Hours,Note,Worker ID,Employee ID\nWorker,Assembly,2026-09-14T08:00:00,,,needs review: next-day clock-in before clock-out; hours withheld,worker,');
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('hours are blank'), 'info');
  } finally {
    await act(async () => tree.unmount());
  }
});

it.each(['Export CSV', 'Export hours CSV'])('downloads record identifiers from the normal %s action', async (label) => {
  const event = (worker: string, id: string, timestamp: string, event_type: string, extra = {}) => ({ id, worker_id: worker, worker_name: 'Same name', worker_department: 'Assembly', timestamp, event_type, ...extra });
  const events = [
    event('worker-a', 'a-in', '2026-09-14T08:00:00', 'clock_in', { worker_employee_id: 'E-A' }),
    event('worker-a', 'correction:a-out', '2026-09-14T16:00:00', 'clock_out', { worker_employee_id: 'E-A', source: 'correction', correction_id: 'a-out' }),
    event('worker-b', 'b-in', '2026-09-14T09:00:00', 'clock_in'),
    event('worker-b', 'b-out', '2026-09-14T17:00:00', 'clock_out'),
  ];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.startsWith('/api/attendance-corrections') ? { corrections: [] } : url.includes('2026-09-15') ? [] : events)));
  let exported!: Blob;
  vi.stubGlobal('URL', { createObjectURL: (blob: Blob) => { exported = blob; return 'blob:test'; }, revokeObjectURL: vi.fn() });
  vi.stubGlobal('document', { createElement: () => ({ click: vi.fn() }) });
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<LogPage />); });
  try {
    const button = tree.root.findAllByType('button').find(node => node.children.some(child => typeof child === 'string' && child.trim() === label))!;
    expect(button.props.disabled).toBe(false);
    await act(async () => button.props.onClick());
    const csv = await exported.text();
    if (label === 'Export CSV') {
      expect(csv).toContain('Worker ID,Event ID,Correction ID,Employee ID');
      expect(csv).toContain(',worker-a,correction:a-out,a-out,E-A');
      expect(csv).toContain(',worker-b,b-in,,');
    } else {
      expect(csv).toContain('Worker ID,Employee ID');
      expect(csv).toContain(',8.00,,worker-a,E-A');
      expect(csv).toContain(',8.00,,worker-b,');
    }
  } finally { await act(async () => tree.unmount()); }
});
