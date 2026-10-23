import { act, create, ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LogPage from './page';
import { clearPendingDirectCorrection } from '@/lib/direct-correction';

const state = vi.hoisted(() => ({ role: 'admin' as string | undefined, search: 'date=2026-09-14', toast: vi.fn() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(state.search) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: state.toast }) }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => state.role }));

const raw = {
  id: 'raw-1', worker_id: 'worker-1', worker_name: 'Worker One', worker_department: 'Assembly', event_type: 'clock_in',
  kiosk_id: 'entry', kiosk_name: 'Entry', timestamp: '2026-09-14T08:00:00', synced: 1, source: 'kiosk',
};
const inactiveScan = { ...raw, id: 'raw-2', worker_id: 'inactive-1', worker_name: 'Former Worker', worker_department: 'Weld', timestamp: '2026-09-14T09:00:00' };
const derived = {
  ...raw, id: 'correction:c-1', event_type: 'clock_out', kiosk_id: 'supervisor_correction', kiosk_name: 'Supervisor correction',
  timestamp: '2026-09-14T17:00:00', source: 'correction', corrected: true, correction_id: 'c-1', correction_reason: 'Missed scan',
};
const correction = (overrides: object) => ({
  id: 'c-1', date: '2026-09-14', worker_id: 'worker-1', worker_name: 'Worker One', worker_department: 'Assembly',
  action: 'add_clock_out', event_type: 'clock_out', corrected_timestamp: '2026-09-14T17:00:00', original_attendance_id: null,
  original_timestamp: null, original_event_type: null, related_exception_key: null, reason: 'Missed scan', supervisor_name: null,
  actor_name: 'admin@example.com', created_at: '2026-09-14T18:00:00Z', updated_at: '2026-09-14T18:00:00Z', ...overrides,
});
const activeWorkers = [{ id: 'worker-1', name: 'Worker One', department: 'Assembly', photo_url: null, enrolled_at: '', active: 1 }];

type Responses = {
  attendance?: () => unknown[];
  corrections?: () => unknown;
  workers?: () => unknown;
  post?: () => { ok: boolean; status: number; body?: unknown };
};

function stubFetch(responses: Responses) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (init?.method === 'POST') {
      const result = responses.post?.() || { ok: true, status: 201, body: { id: 'new' } };
      return ok(result.body ?? {}, result.status);
    }
    if (url.startsWith('/api/workers')) {
      const body = responses.workers ? responses.workers() : activeWorkers;
      return body instanceof Error ? ok({ error: 'down' }, 500) : ok(body);
    }
    if (url.startsWith('/api/attendance-corrections')) {
      const body = responses.corrections ? responses.corrections() : { corrections: [] };
      return body instanceof Error ? ok({ error: 'down' }, 500) : ok(body);
    }
    return ok(responses.attendance ? responses.attendance() : [raw]);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function text(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === 'string' ? child : text(child)).join('');
}
function buttonsNamed(tree: ReactTestRenderer, label: string) {
  return tree.root.findAllByType('button').filter((node) => text(node).trim() === label);
}
async function render() {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<LogPage />); });
  return tree;
}
async function change(node: ReactTestInstance, value: string) {
  await act(async () => node.props.onChange({ target: { value } }));
}

beforeEach(() => {
  state.role = 'admin';
  state.search = 'date=2026-09-14';
  clearPendingDirectCorrection();
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('role gating', () => {
  it('gives viewers no correction controls and does not load the worker list', async () => {
    state.role = 'viewer';
    const fetchMock = stubFetch({ attendance: () => [raw, derived], corrections: () => ({ corrections: [correction({})] }) });
    const tree = await render();
    try {
      expect(buttonsNamed(tree, 'Correct')).toHaveLength(0);
      expect(buttonsNamed(tree, 'Reverse')).toHaveLength(0);
      expect(buttonsNamed(tree, 'Add missing punch')).toHaveLength(0);
      expect(text(tree.root)).not.toContain('Action');
      expect(text(tree.root)).toContain('Direct (no exception)');
      expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/workers'))).toBe(false);
    } finally {
      await act(async () => tree.unmount());
    }
  });

  it('shows no controls while the role is still resolving', async () => {
    state.role = undefined;
    stubFetch({});
    const tree = await render();
    try {
      expect(buttonsNamed(tree, 'Correct')).toHaveLength(0);
      expect(buttonsNamed(tree, 'Add missing punch')).toHaveLength(0);
    } finally {
      await act(async () => tree.unmount());
    }
  });
});

describe('admin and enrollment controls', () => {
  it.each(['admin', 'enrollment'])('%s sees Correct on raw rows, Reverse on correction rows, and Add missing punch', async (role) => {
    state.role = role;
    stubFetch({
      attendance: () => [derived, raw],
      corrections: () => ({ corrections: [correction({}), correction({ id: 'c-2', action: 'void_event', related_exception_key: 'scan_sequence:x' })] }),
    });
    const tree = await render();
    try {
      expect(buttonsNamed(tree, 'Correct')).toHaveLength(1);
      expect(buttonsNamed(tree, 'Add missing punch')[0].props.disabled).toBe(false);
      const historyText = text(tree.root.findAllByType('section').at(-1)!);
      expect(historyText).toContain('Direct (no exception)');
      expect(historyText).toContain('From exception');
      expect(historyText).toContain('Actor: admin@example.com');

      // The derived row's Reverse opens the existing reversal draft.
      const [rowReverse] = buttonsNamed(tree, 'Reverse');
      await act(async () => rowReverse.props.onClick());
      expect(tree.root.findByProps({ id: 'reversal-reason' })).toBeTruthy();
      expect(text(tree.root)).toContain('Correction c-1');
    } finally {
      await act(async () => tree.unmount());
    }
  });

  it('voids a raw row, then reloads events and history and toasts', async () => {
    let saved = false;
    const fetchMock = stubFetch({
      attendance: () => saved ? [] : [raw],
      corrections: () => ({ corrections: saved ? [correction({ action: 'void_event', original_attendance_id: 'raw-1', reason: 'Wrong person' })] : [] }),
      post: () => { saved = true; return { ok: true, status: 201, body: { id: 'c-9' } }; },
    });
    const tree = await render();
    try {
      await act(async () => buttonsNamed(tree, 'Correct')[0].props.onClick({ currentTarget: null }));
      expect(tree.root.findByProps({ role: 'dialog' })).toBeTruthy();
      await change(tree.root.findAllByType('textarea')[0], 'Wrong person');
      await act(async () => buttonsNamed(tree, 'Void row')[0].props.onClick());
      const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST')!;
      expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({
        date: '2026-09-14', worker_id: 'worker-1', action: 'void_event', original_attendance_id: 'raw-1', reason: 'Wrong person', request_id: expect.any(String),
      });
      expect(state.toast).toHaveBeenCalledWith('Attendance correction saved');
      expect(tree.root.findAll((node) => node.props.role === 'dialog')).toHaveLength(0);
      expect(fetchMock.mock.calls.filter(([url]) => url === '/api/attendance?date=2026-09-14')).toHaveLength(2);
      expect(fetchMock.mock.calls.filter(([url]) => url === '/api/attendance-corrections?date=2026-09-14')).toHaveLength(2);
      expect(text(tree.root)).toContain('Void Event');
      expect(text(tree.root)).toContain('Direct (no exception)');
    } finally {
      await act(async () => tree.unmount());
    }
  });
});

describe('readiness guards', () => {
  it('disables corrections when history fails and recovers on Retry', async () => {
    let fail = true;
    stubFetch({ corrections: () => fail ? new Error('down') : { corrections: [] } });
    const tree = await render();
    try {
      expect(buttonsNamed(tree, 'Correct')).toHaveLength(0);
      const add = buttonsNamed(tree, 'Add missing punch')[0];
      expect(add.props.disabled).toBe(true);
      expect(text(tree.root.findByProps({ id: 'add-punch-status' }))).toContain('did not load');
      fail = false;
      await act(async () => buttonsNamed(tree, 'Retry')[0].props.onClick());
      expect(buttonsNamed(tree, 'Add missing punch')[0].props.disabled).toBe(false);
      expect(buttonsNamed(tree, 'Correct')[0].props.disabled).toBe(false);
    } finally {
      await act(async () => tree.unmount());
    }
  });

  it('disables Add missing punch when the worker list fails and retries it', async () => {
    let fail = true;
    stubFetch({ workers: () => fail ? new Error('down') : activeWorkers });
    const tree = await render();
    try {
      expect(buttonsNamed(tree, 'Add missing punch')[0].props.disabled).toBe(true);
      expect(text(tree.root.findByProps({ id: 'add-punch-status' }))).toContain('Could not load the worker list.');
      // Voiding does not depend on the worker list.
      expect(buttonsNamed(tree, 'Correct')[0].props.disabled).toBe(false);
      fail = false;
      await act(async () => buttonsNamed(tree, 'Retry')[0].props.onClick());
      expect(buttonsNamed(tree, 'Add missing punch')[0].props.disabled).toBe(false);
    } finally {
      await act(async () => tree.unmount());
    }
  });

  it('reports no selectable workers for a filtered inactive worker with no evidence', async () => {
    state.search = 'date=2026-09-14&worker_id=inactive-1';
    stubFetch({ attendance: () => [] });
    const tree = await render();
    try {
      expect(buttonsNamed(tree, 'Add missing punch')[0].props.disabled).toBe(true);
      expect(text(tree.root.findByProps({ id: 'add-punch-status' }))).toContain('No selectable workers');
    } finally {
      await act(async () => tree.unmount());
    }
  });

  it('blocks corrections on a future date', async () => {
    state.search = 'date=2999-01-01';
    stubFetch({ attendance: () => [{ ...raw, timestamp: '2999-01-01T08:00:00' }] });
    const tree = await render();
    try {
      expect(buttonsNamed(tree, 'Add missing punch')[0].props.disabled).toBe(true);
      expect(buttonsNamed(tree, 'Correct')[0].props.disabled).toBe(true);
    } finally {
      await act(async () => tree.unmount());
    }
  });
});

describe('worker filter and inactive retention', () => {
  it('locks a filtered log to that worker and keeps an inactive worker selectable after voiding their only row', async () => {
    state.search = 'date=2026-09-14&worker_id=inactive-1';
    let voided = false;
    stubFetch({
      attendance: () => voided ? [] : [inactiveScan],
      // The void's history row still names the worker after the raw row leaves effective attendance.
      corrections: () => ({ corrections: voided ? [correction({ worker_id: 'inactive-1', worker_name: 'Former Worker', worker_department: 'Weld', action: 'void_event', original_attendance_id: 'raw-2' })] : [] }),
      post: () => { voided = true; return { ok: true, status: 201 }; },
    });
    const tree = await render();
    try {
      await act(async () => buttonsNamed(tree, 'Correct')[0].props.onClick({ currentTarget: null }));
      await change(tree.root.findAllByType('textarea')[0], 'Scan was the wrong worker');
      await act(async () => buttonsNamed(tree, 'Void row')[0].props.onClick());
      expect(buttonsNamed(tree, 'Correct')).toHaveLength(0);

      const add = buttonsNamed(tree, 'Add missing punch')[0];
      expect(add.props.disabled).toBe(false);
      await act(async () => add.props.onClick({ currentTarget: null }));
      const [worker] = tree.root.findByProps({ role: 'dialog' }).findAllByType('select');
      expect(worker.props.disabled).toBe(true);
      expect(worker.props.value).toBe('inactive-1');
      expect(worker.findAllByType('option').map((option) => text(option))).toEqual(['Former Worker · Weld (inactive)']);
    } finally {
      await act(async () => tree.unmount());
    }
  });

  it('closes an open draft when the date changes', async () => {
    stubFetch({});
    const tree = await render();
    try {
      await act(async () => buttonsNamed(tree, 'Add missing punch')[0].props.onClick({ currentTarget: null }));
      expect(tree.root.findAll((node) => node.props.role === 'dialog')).toHaveLength(1);
      await act(async () => tree.root.findByProps({ type: 'date' }).props.onChange({ target: { value: '2026-09-13' } }));
      expect(tree.root.findAll((node) => node.props.role === 'dialog')).toHaveLength(0);
    } finally {
      await act(async () => tree.unmount());
    }
  });
});

describe('uncertain save on the page', () => {
  it('locks new drafts while a save is in flight, even after navigating away, and a late success clears only that save', async () => {
    let resolvePost!: (value: unknown) => void;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Promise((resolve) => { resolvePost = resolve; });
      if (url.startsWith('/api/workers')) return { ok: true, status: 200, json: async () => activeWorkers };
      if (url.startsWith('/api/attendance-corrections')) return { ok: true, status: 200, json: async () => ({ corrections: [] }) };
      return { ok: true, status: 200, json: async () => [{ ...raw, timestamp: url.includes('2026-09-13') ? '2026-09-13T08:00:00' : raw.timestamp }] };
    });
    vi.stubGlobal('fetch', fetchMock);
    const tree = await render();
    try {
      await act(async () => buttonsNamed(tree, 'Correct')[0].props.onClick({ currentTarget: null }));
      await change(tree.root.findAllByType('textarea')[0], 'Wrong person');
      await act(async () => { buttonsNamed(tree, 'Void row')[0].props.onClick(); });
      // Navigate to another date while save A is still pending.
      await act(async () => tree.root.findByProps({ type: 'date' }).props.onChange({ target: { value: '2026-09-13' } }));
      expect(tree.root.findAll((node) => node.props.role === 'dialog')).toHaveLength(0);
      expect(buttonsNamed(tree, 'Correct')[0].props.disabled).toBe(true);
      expect(buttonsNamed(tree, 'Add missing punch')[0].props.disabled).toBe(true);
      expect(text(tree.root)).toContain('Open 2026-09-14 to retry the same save');

      await act(async () => resolvePost({ ok: true, status: 201, json: async () => ({ id: 'c-a' }) }));
      expect(text(tree.root)).not.toContain('Save may have completed:');
      expect(buttonsNamed(tree, 'Correct')[0].props.disabled).toBe(false);
      expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toHaveLength(1);
    } finally {
      await act(async () => tree.unmount());
    }
  });

  it('keeps an unconfirmed save across dialog close and lets only the same request be retried', async () => {
    let posts = 0;
    const fetchMock = stubFetch({
      post: () => {
        posts += 1;
        if (posts === 1) throw new Error('connection lost');
        return { ok: true, status: 201 };
      },
    });
    const tree = await render();
    try {
      await act(async () => buttonsNamed(tree, 'Add missing punch')[0].props.onClick({ currentTarget: null }));
      const dialog = () => tree.root.findByProps({ role: 'dialog' });
      await change(dialog().findAllByType('select')[0], 'worker-1');
      await change(dialog().findByProps({ type: 'time' }), '16:00');
      await change(dialog().findByType('textarea'), 'Forgot to clock out');
      await act(async () => buttonsNamed(tree, 'Add punch')[0].props.onClick());
      await act(async () => buttonsNamed(tree, 'Close (keep pending)')[0].props.onClick());
      expect(text(tree.root)).toContain('Save may have completed:');

      // A new Correct click reopens the frozen save instead of a fresh draft.
      await act(async () => buttonsNamed(tree, 'Correct')[0].props.onClick({ currentTarget: null }));
      expect(dialog().findByType('textarea').props.value).toBe('Forgot to clock out');
      expect(dialog().findByType('textarea').props.disabled).toBe(true);
      await act(async () => buttonsNamed(tree, 'Retry same save').at(-1)!.props.onClick());

      const bodies = fetchMock.mock.calls
        .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
        .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toEqual(bodies[0]);
      expect(text(tree.root)).not.toContain('Save may have completed:');
      expect(state.toast).toHaveBeenCalledWith('Attendance correction saved');
    } finally {
      await act(async () => tree.unmount());
    }
  });
});
