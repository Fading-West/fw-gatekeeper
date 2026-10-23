import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import LogPage from './page';

const { toast, selection } = vi.hoisted(() => ({ toast: vi.fn(), selection: { params: 'date=2026-09-14' } }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(selection.params) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'admin' }));
vi.mock('@/components/AttendanceTable', () => ({ default: () => null, attendanceRowId: (id: string) => id }));

let tree: ReactTestRenderer | undefined;
afterEach(async () => {
  if (tree) await act(async () => tree!.unmount());
  tree = undefined;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  selection.params = 'date=2026-09-14';
});

const button = (label: string) => tree!.root.findAllByType('button').find(node => node.children.includes(label))!;

async function renderPendingExport() {
  const correction = {
    id: 'added-exit', date: '2026-09-14', worker_id: 'worker', worker_name: 'Worker',
    action: 'add_clock_out', corrected_timestamp: '2026-09-14T16:00:00', reason: 'Missed exit',
  };
  const event = (time: string, event_type: string) => ({
    id: time, worker_id: 'worker', worker_name: 'Worker', worker_department: 'Assembly',
    timestamp: `2026-09-14T${time}:00`, event_type,
  });
  let reversed = false;
  let release!: () => void;
  const neighboringDay = new Promise<void>(resolve => { release = resolve; });
  const signals: AbortSignal[] = [];
  let hold = true;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      reversed = true;
      return Response.json({ id: 'reversal' });
    }
    if (url.startsWith('/api/attendance-corrections')) {
      return Response.json({ corrections: [{ ...correction, ...(reversed ? { reversal_id: 'reversal' } : {}) }] });
    }
    if (url.startsWith('/api/workers')) return Response.json([]);
    if (url.includes('date=2026-09-14')) {
      return Response.json(reversed ? [event('08:00', 'clock_in')] : [
        event('08:00', 'clock_in'),
        { ...event('16:00', 'clock_out'), id: 'correction:added-exit', source: 'correction', correction_id: correction.id },
      ]);
    }
    if (hold) {
      if (init?.signal) signals.push(init.signal);
      // Deliberately ignore abort: a late network/body completion must also
      // be checked before any download or toast.
      await neighboringDay;
      return Response.json([]);
    }
    return Response.json([]);
  });
  vi.stubGlobal('fetch', fetchMock);
  const downloads: Blob[] = [];
  vi.stubGlobal('URL', { createObjectURL: (blob: Blob) => { downloads.push(blob); return 'blob:test'; }, revokeObjectURL: vi.fn() });
  vi.stubGlobal('document', { createElement: () => ({ click: vi.fn() }) });
  await act(async () => { tree = create(<LogPage />); });
  let pending!: Promise<void>;
  await act(async () => { pending = button('Export hours CSV').props.onClick(); });
  return {
    downloads, signals, fetchMock,
    finish: async () => {
      hold = false;
      await act(async () => { release(); await pending; });
    },
  };
}

it('does not download superseded payroll hours after a correction reversal refreshes the log', async () => {
  const page = await renderPendingExport();
  await act(async () => button('Reverse').props.onClick());
  await act(async () => tree!.root.findByType('textarea').props.onChange({ target: { value: 'Exit was recorded for the wrong time' } }));
  await act(async () => button('Confirm reversal').props.onClick());
  expect(toast).toHaveBeenCalledWith('Correction reversed');
  await page.finish();
  // Before the fix this contains an apparently valid 8.00-hour payroll row,
  // even though reversing the only exit leaves an unclosed shift.
  expect(await Promise.all(page.downloads.map(blob => blob.text()))).toEqual([]);
  expect(page.signals).toHaveLength(2);
  expect(page.signals.every(signal => signal.aborted)).toBe(true);

  await act(async () => button('Export hours CSV').props.onClick());
  expect(page.downloads).toHaveLength(1);
  expect(await page.downloads[0].text()).toContain('hours withheld');
  expect(await page.downloads[0].text()).not.toContain(',8.00,');
});

it('shows a pending export and ignores a second click before the first export completes', async () => {
  const page = await renderPendingExport();
  const preparing = button('Preparing hours…');
  expect(preparing.props.disabled).toBe(true);
  await act(async () => preparing.props.onClick());
  expect(page.fetchMock.mock.calls.filter(([url]) => url.includes('date=2026-09-13') || url.includes('date=2026-09-15'))).toHaveLength(2);
  await page.finish();
  expect(page.downloads).toHaveLength(1);
  expect(await page.downloads[0].text()).toContain(',8.00,');
  expect(button('Export hours CSV').props.disabled).toBe(false);
});

it.each(['date', 'worker', 'unmount'])('retires a pending hours export on %s changes', async (change) => {
  const page = await renderPendingExport();
  if (change === 'date') {
    await act(async () => tree!.root.findAllByType('input').find(node => node.props.type === 'date')!.props.onChange({ target: { value: '2026-09-16' } }));
  } else if (change === 'worker') {
    selection.params += '&worker_id=other-worker';
    await act(async () => tree!.update(<LogPage />));
  } else {
    await act(async () => tree!.unmount());
    tree = undefined;
  }
  await page.finish();
  expect(page.downloads).toHaveLength(0);
  expect(page.signals).toHaveLength(2);
  expect(page.signals.every(signal => signal.aborted)).toBe(true);
  expect(toast).not.toHaveBeenCalled();
});
