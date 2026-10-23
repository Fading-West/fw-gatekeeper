import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import LogPage from './page';

const { toast, selection } = vi.hoisted(() => ({ toast: vi.fn(), selection: { params: 'date=2026-09-14' } }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(selection.params) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'viewer' }));
vi.mock('@/components/AttendanceTable', () => ({ default: () => null, attendanceRowId: (id: string) => id }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); selection.params = 'date=2026-09-14'; });

it.each(['Export CSV', 'Export hours CSV'])('neutralizes worker-supplied formulas in %s', async (label) => {
  const events = [
    { id: 'in', worker_id: 'worker', worker_name: '=1+1', worker_department: '+1+2', timestamp: '2026-09-14T08:00:00', event_type: 'clock_in', note: '@SUM(A1:A2)' },
    { id: 'out', worker_id: 'worker', worker_name: '=1+1', worker_department: '+1+2', timestamp: '2026-09-14T16:00:00', event_type: 'clock_out' },
  ];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () =>
    url.startsWith('/api/attendance-corrections') ? { corrections: [] } : url.includes('2026-09-14') ? events : [],
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
    url.includes('2026-09-13') ? [] :
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

it.each([
  ['2026-09-14', '2026-09-13', '2026-09-15'],
  ['2026-11-01', '2026-10-31', '2026-11-02'],
  ['2026-03-08', '2026-03-07', '2026-03-09'],
  ['2027-01-01', '2026-12-31', '2027-01-02'],
])('fetches only neighboring factory dates with the worker filter for %s', async (date, previous, next) => {
  selection.params = `date=${date}&worker_id=worker`;
  const event = (timestamp: string, event_type: string) => ({ id: timestamp, worker_id: 'worker', worker_name: 'Worker', worker_department: 'Assembly', timestamp, event_type });
  const fetchMock = vi.fn(async (url: string) => ({ ok: true, json: async () =>
    url.startsWith('/api/attendance-corrections') ? { corrections: [] } :
    url.includes(previous) ? [event(`${previous}T22:00:00`, 'clock_in')] :
    url.includes(date) ? [event(`${date}T06:00:00`, 'clock_out')] : [],
  }));
  vi.stubGlobal('fetch', fetchMock);
  let exported!: Blob;
  vi.stubGlobal('URL', { createObjectURL: (blob: Blob) => { exported = blob; return 'blob:test'; }, revokeObjectURL: vi.fn() });
  vi.stubGlobal('document', { createElement: () => ({ click: vi.fn() }) });
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<LogPage />); });
  try {
    await act(async () => tree.root.findAllByType('button').find((node) => node.children.includes('Export hours CSV'))!.props.onClick());
    expect(fetchMock.mock.calls.map(([url]) => url).filter((url) => url.startsWith('/api/attendance?')).sort()).toEqual([
      `/api/attendance?date=${previous}&worker_id=worker`,
      `/api/attendance?date=${date}&worker_id=worker`,
      `/api/attendance?date=${next}&worker_id=worker`,
    ].sort());
    expect(await exported.text()).toBe(`Worker,Department,First In,Last Out,Hours,Note\nWorker,Assembly,,${date}T06:00:00,0.00,overnight shift hours counted on ${previous}`);
    expect(toast).not.toHaveBeenCalled();
  } finally {
    await act(async () => tree.unmount());
  }
});

it.each([
  ['2026-09-13', false, []], ['2026-09-15', false, []],
  ['2026-09-13', true, {}], ['2026-09-15', true, {}],
])('cancels the export when neighboring date %s returns ok=%s and %j', async (failedDate, ok, payload) => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes(failedDate)
    ? { ok, status: 500, json: async () => payload }
    : { ok: true, json: async () => url.startsWith('/api/attendance-corrections') ? { corrections: [] } : [] }));
  const download = vi.fn();
  vi.stubGlobal('URL', { createObjectURL: download, revokeObjectURL: vi.fn() });
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<LogPage />); });
  try {
    await act(async () => tree.root.findAllByType('button').find((node) => node.children.includes('Export hours CSV'))!.props.onClick());
    expect(download).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('Export cancelled'), 'error');
  } finally {
    await act(async () => tree.unmount());
  }
});
