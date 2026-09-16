import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import LogPage from './page';

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('date=2026-09-14') }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/components/AttendanceTable', () => ({ default: () => null, attendanceRowId: (id: string) => id }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

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
    expect(await exported.text()).toBe('Worker,Department,First In,Last Out,Hours,Note\nWorker,Assembly,2026-09-14T08:00:00,,,needs review: next-day clock-in before clock-out; hours withheld');
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('hours are blank'), 'info');
  } finally {
    await act(async () => tree.unmount());
  }
});
