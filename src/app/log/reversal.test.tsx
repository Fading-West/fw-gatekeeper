import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import LogPage from './page';

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('date=2026-09-14&worker_id=worker-1') }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'admin' }));
vi.mock('@/components/AttendanceTable', () => ({ default: () => null, attendanceRowId: (id: string) => id }));

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('retries a reversal with the same request ID and reloads the selected view after success', async () => {
  const correction = {
    id: 'correction-1', date: '2026-09-14', worker_id: 'worker-1', worker_name: 'Worker', worker_department: 'Assembly',
    action: 'add_clock_in', event_type: 'clock_in', corrected_timestamp: '2026-09-14T08:00:00',
    original_attendance_id: null, original_timestamp: null, original_event_type: null, related_exception_key: null,
    reason: 'Missed scan', supervisor_name: 'Supervisor', created_at: '2026-09-14T08:00:00', updated_at: '2026-09-14T08:00:00',
  };
  let postSucceeded = false;
  let attempts = 0;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    if (init?.method === 'PATCH') {
      attempts += 1;
      if (attempts === 1) throw new Error('Connection lost after save');
      postSucceeded = true;
      return { ok: true, json: async () => ({ id: 'reversal-1' }) };
    }
    if (url.startsWith('/api/attendance-corrections')) {
      return { ok: true, json: async () => ({ corrections: [postSucceeded ? { ...correction, reversal_id: 'reversal-1', reversal_reason: 'Wrong scan' } : correction] }) };
    }
    return { ok: true, json: async () => postSucceeded ? [] : [{ id: 'correction:correction-1' }] };
  }));

  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<LogPage />); });
  try {
    const button = tree.root.findAllByType('button').find((node) => node.children.includes('Reverse'))!;
    await act(async () => button.props.onClick());
    const textarea = tree.root.findByType('textarea');
    await act(async () => textarea.props.onChange({ target: { value: 'Wrong scan' } }));
    const submit = () => tree.root.findAllByType('button').find((node) => node.children.includes('Confirm reversal'))!;
    await act(async () => submit().props.onClick());
    expect(toast).toHaveBeenCalledWith('Connection lost after save', 'error');
    await act(async () => submit().props.onClick());
    const patches = requests.filter((request) => request.init?.method === 'PATCH');
    expect(patches).toHaveLength(2);
    expect(JSON.parse(String(patches[0].init?.body)).request_id).toBe(JSON.parse(String(patches[1].init?.body)).request_id);
    expect(requests.filter((request) => request.url === '/api/attendance?date=2026-09-14&worker_id=worker-1')).toHaveLength(2);
    expect(requests.filter((request) => request.url === '/api/attendance-corrections?date=2026-09-14&worker_id=worker-1')).toHaveLength(3);
    expect(tree.root.findAllByType('span').some((node) => node.children.includes('Reversed'))).toBe(true);
  } finally {
    await act(async () => tree.unmount());
  }
});

it('reconciles a saved reversal after a lost response and an edited-reason conflict', async () => {
  const correction = {
    id: 'correction-2', date: '2026-09-14', worker_id: 'worker-1', worker_name: 'Worker', worker_department: 'Assembly',
    action: 'add_clock_in', event_type: 'clock_in', corrected_timestamp: '2026-09-14T08:00:00',
    original_attendance_id: null, original_timestamp: null, original_event_type: null, related_exception_key: null,
    reason: 'Missed scan', supervisor_name: 'Supervisor', created_at: '2026-09-14T08:00:00', updated_at: '2026-09-14T08:00:00',
  };
  let patches = 0;
  let correctionReads = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      patches += 1;
      if (patches === 1) throw new Error('Connection lost after save');
      return { ok: false, json: async () => ({ error: 'Correction has already been reversed.' }) };
    }
    if (url.startsWith('/api/attendance-corrections')) {
      correctionReads += 1;
      if (correctionReads === 2) throw new Error('History temporarily unavailable');
      return { ok: true, json: async () => ({ corrections: [{
        ...correction, ...(patches ? { reversal_id: 'reversal-2', reversal_reason: 'Original reason' } : {}),
      }] }) };
    }
    return { ok: true, json: async () => patches ? [] : [{ id: 'correction:correction-2' }] };
  }));

  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<LogPage />); });
  try {
    await act(async () => tree.root.findAllByType('button').find((node) => node.children.includes('Reverse'))!.props.onClick());
    const editReason = async (value: string) => act(async () => tree.root.findByType('textarea').props.onChange({ target: { value } }));
    const submit = async () => act(async () => tree.root.findAllByType('button').find((node) => node.children.includes('Confirm reversal'))!.props.onClick());
    await editReason('Original reason');
    await submit();
    expect(tree.root.findAllByType('textarea')).toHaveLength(1);
    expect(toast).toHaveBeenCalledWith('Connection lost after save Save status is unknown; refresh history before editing the reason or retrying.', 'error');
    await editReason('Edited reason');
    await submit();
    expect(patches).toBe(2);
    const patchRequests = vi.mocked(fetch).mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
    expect(JSON.parse(String(patchRequests[0][1]?.body)).request_id).not.toBe(JSON.parse(String(patchRequests[1][1]?.body)).request_id);
    expect(toast).toHaveBeenCalledWith('A reversal is already recorded. Your request could not be confirmed. Recorded reason: Original reason', 'info');
    expect(tree.root.findAllByType('textarea')).toHaveLength(0);
    expect(tree.root.findAllByType('span').some((node) => node.children.includes('Reversed'))).toBe(true);
  } finally {
    await act(async () => tree.unmount());
  }
});

it('reports a competing operator reversal without claiming this request succeeded', async () => {
  const correction = {
    id: 'correction-3', date: '2026-09-14', worker_id: 'worker-1', worker_name: 'Worker', worker_department: 'Assembly',
    action: 'add_clock_in', event_type: 'clock_in', corrected_timestamp: '2026-09-14T08:00:00',
    original_attendance_id: null, original_timestamp: null, original_event_type: null, related_exception_key: null,
    reason: 'Missed scan', supervisor_name: 'Supervisor', created_at: '2026-09-14T08:00:00', updated_at: '2026-09-14T08:00:00',
  };
  let attempted = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      attempted = true;
      return { ok: false, json: async () => ({ error: 'Correction has already been reversed.' }) };
    }
    if (url.startsWith('/api/attendance-corrections')) return { ok: true, json: async () => ({ corrections: [{
      ...correction, ...(attempted ? { reversal_id: 'other-reversal', reversal_reason: 'Other operator reason', reversed_by_name: 'Other Admin' } : {}),
    }] }) };
    return { ok: true, json: async () => [] };
  }));
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<LogPage />); });
  try {
    await act(async () => tree.root.findAllByType('button').find((node) => node.children.includes('Reverse'))!.props.onClick());
    await act(async () => tree.root.findByType('textarea').props.onChange({ target: { value: 'My reason' } }));
    await act(async () => tree.root.findAllByType('button').find((node) => node.children.includes('Confirm reversal'))!.props.onClick());
    expect(toast).toHaveBeenCalledWith('A reversal is already recorded. Your request could not be confirmed. Recorded reason: Other operator reason', 'info');
    expect(toast).not.toHaveBeenCalledWith('Correction reversed');
    expect(tree.root.findAllByType('textarea')).toHaveLength(0);
  } finally {
    await act(async () => tree.unmount());
  }
});

it('treats an HTTP 200 unavailable-history fallback as an unknown save status', async () => {
  const correction = {
    id: 'correction-4', date: '2026-09-14', worker_id: 'worker-1', worker_name: 'Worker', worker_department: 'Assembly',
    action: 'add_clock_in', event_type: 'clock_in', corrected_timestamp: '2026-09-14T08:00:00',
    original_attendance_id: null, original_timestamp: null, original_event_type: null, related_exception_key: null,
    reason: 'Missed scan', supervisor_name: 'Supervisor', created_at: '2026-09-14T08:00:00', updated_at: '2026-09-14T08:00:00',
  };
  let attempted = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      attempted = true;
      throw new Error('Connection lost after save');
    }
    if (url.startsWith('/api/attendance-corrections')) return { ok: true, json: async () => attempted
      ? { corrections: [], backend_unavailable: true }
      : { corrections: [correction] } };
    return { ok: true, json: async () => [] };
  }));
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<LogPage />); });
  try {
    await act(async () => tree.root.findAllByType('button').find((node) => node.children.includes('Reverse'))!.props.onClick());
    await act(async () => tree.root.findByType('textarea').props.onChange({ target: { value: 'Wrong scan' } }));
    await act(async () => tree.root.findAllByType('button').find((node) => node.children.includes('Confirm reversal'))!.props.onClick());
    expect(toast).toHaveBeenCalledWith('Connection lost after save Save status is unknown; refresh history before editing the reason or retrying.', 'error');
    expect(tree.root.findAllByType('textarea')).toHaveLength(1);
  } finally {
    await act(async () => tree.unmount());
  }
});

it('discards a reversal draft when the selected date changes', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true,
    json: async () => url.startsWith('/api/attendance-corrections') ? { corrections: [{
      id: 'correction-1', date: '2026-09-14', worker_id: 'worker-1', worker_name: 'Worker', worker_department: 'Assembly',
      action: 'add_clock_in', event_type: 'clock_in', corrected_timestamp: '2026-09-14T08:00:00',
      original_attendance_id: null, original_timestamp: null, original_event_type: null, related_exception_key: null,
      reason: 'Missed scan', supervisor_name: 'Supervisor', created_at: '2026-09-14T08:00:00', updated_at: '2026-09-14T08:00:00',
    }] } : [],
  })));
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<LogPage />); });
  try {
    await act(async () => tree.root.findAllByType('button').find((node) => node.children.includes('Reverse'))!.props.onClick());
    await act(async () => tree.root.findByType('textarea').props.onChange({ target: { value: 'Wrong scan' } }));
    await act(async () => tree.root.findByType('input').props.onChange({ target: { value: '2026-09-15' } }));
    expect(tree.root.findAllByType('textarea')).toHaveLength(0);
    expect(tree.root.findAllByType('button').filter((node) => node.children.includes('Confirm reversal'))).toHaveLength(0);
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')).toBe(false);
  } finally {
    await act(async () => tree.unmount());
  }
});

it('shows a settled error after the selected date fails to load', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('2026-09-15')) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => url.startsWith('/api/attendance-corrections') ? { corrections: [] } : [] };
  }));
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<LogPage />); });
  try {
    await act(async () => tree.root.findByType('input').props.onChange({ target: { value: '2026-09-15' } }));
    expect(tree.root.findByProps({ role: 'alert' }).children).toContain('Failed to load activity log');
    expect(tree.root.findAllByType('div').some((node) => node.children.includes('Loading activity log...'))).toBe(false);
    expect(tree.root.findAllByType('button').find((node) => node.children.includes('Export CSV'))?.props.disabled).toBe(true);
  } finally {
    await act(async () => tree.unmount());
  }
});

it('shows a settled error when the post-reversal refresh fails', async () => {
  const correction = {
    id: 'correction-1', date: '2026-09-14', worker_id: 'worker-1', worker_name: 'Worker', worker_department: 'Assembly',
    action: 'add_clock_in', event_type: 'clock_in', corrected_timestamp: '2026-09-14T08:00:00',
    original_attendance_id: null, original_timestamp: null, original_event_type: null, related_exception_key: null,
    reason: 'Missed scan', supervisor_name: 'Supervisor', created_at: '2026-09-14T08:00:00', updated_at: '2026-09-14T08:00:00',
  };
  let reversed = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      reversed = true;
      return { ok: true, json: async () => ({ id: 'reversal-1' }) };
    }
    if (reversed) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => url.startsWith('/api/attendance-corrections') ? { corrections: [correction] } : [] };
  }));
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<LogPage />); });
  try {
    await act(async () => tree.root.findAllByType('button').find((node) => node.children.includes('Reverse'))!.props.onClick());
    await act(async () => tree.root.findByType('textarea').props.onChange({ target: { value: 'Wrong scan' } }));
    await act(async () => tree.root.findAllByType('button').find((node) => node.children.includes('Confirm reversal'))!.props.onClick());
    expect(tree.root.findByProps({ role: 'alert' }).children).toContain('Failed to load activity log');
    expect(tree.root.findAllByType('div').some((node) => node.children.includes('Loading activity log...'))).toBe(false);
  } finally {
    await act(async () => tree.unmount());
  }
});
