import { act, create, ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AttendanceCorrectionDialog, { AttendanceCorrectionDialogProps } from './AttendanceCorrectionDialog';
import { readPendingDirectCorrection, clearPendingDirectCorrection } from '@/lib/direct-correction';
import type { AttendanceWithWorker } from '@/lib/types';

const rawScan: AttendanceWithWorker = {
  id: 'raw-1', worker_id: 'worker-1', event_type: 'clock_in', kiosk_id: 'entry', timestamp: '2026-09-14T08:00:00',
  synced: 1, source: 'kiosk', worker_name: 'Worker One', worker_department: 'Assembly', kiosk_name: 'Entry Kiosk',
};
const workers = [
  { id: 'worker-1', name: 'Worker One', department: 'Assembly', active: true },
  { id: 'worker-2', name: 'Former Worker', department: 'Weld', active: false },
];
// 2026-09-14 22:00Z is 17:00 CDT at the factory.
const now = () => new Date('2026-09-14T22:00:00Z');

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

function buttons(tree: ReactTestRenderer) {
  return tree.root.findAllByType('button');
}
function button(tree: ReactTestRenderer, label: string) {
  const match = buttons(tree).find((node) => node.children.some((child) => typeof child === 'string' && child.includes(label)));
  if (!match) throw new Error(`No button ${label}: ${buttons(tree).map((node) => node.children.join('')).join(' | ')}`);
  return match;
}
function hasButton(tree: ReactTestRenderer, label: string) {
  return buttons(tree).some((node) => node.children.some((child) => typeof child === 'string' && child.includes(label)));
}
function text(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === 'string' ? child : text(child)).join('');
}
function alerts(tree: ReactTestRenderer) {
  return tree.root.findAll((node) => node.props.role === 'alert' && typeof node.type === 'string').map(text);
}
async function change(node: ReactTestInstance, value: string) {
  await act(async () => node.props.onChange({ target: { value } }));
}
function postBodies() {
  return vi.mocked(fetch).mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

async function render(props: Partial<AttendanceCorrectionDialogProps> = {}) {
  const handlers = { onPendingStart: vi.fn(), onPendingSettled: vi.fn(), onSaved: vi.fn(), onClose: vi.fn() };
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <AttendanceCorrectionDialog
        date="2026-09-14"
        mode="void"
        sourceEvent={rawScan}
        workerOptions={workers}
        effectiveEvents={[rawScan]}
        ready
        now={now}
        {...handlers}
        {...props}
      />,
    );
  });
  return { tree, ...handlers };
}

beforeEach(() => {
  vi.stubGlobal('sessionStorage', storage());
  clearPendingDirectCorrection();
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('void mode', () => {
  it('shows the source row read-only and posts a direct void without an exception key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ id: 'correction-1' }) })));
    const { tree, onSaved } = await render();
    const readOnly = tree.root.findAllByType('input').filter((input) => input.props.readOnly).map((input) => input.props.value);
    expect(readOnly).toEqual(['Worker One · Assembly', 'Clock in', expect.stringMatching(/08:00:00/), 'Entry Kiosk']);
    expect(tree.root.findAllByType('select')).toHaveLength(0);

    expect(button(tree, 'Void row').props.disabled).toBe(true);
    await change(tree.root.findByType('textarea'), '  Scan belongs to worker 2 per badge photo  ');
    await act(async () => button(tree, 'Void row').props.onClick());

    expect(postBodies()).toEqual([{
      date: '2026-09-14', worker_id: 'worker-1', action: 'void_event', original_attendance_id: 'raw-1',
      reason: 'Scan belongs to worker 2 per badge photo', request_id: expect.any(String),
    }]);
    expect(postBodies()[0]).not.toHaveProperty('related_exception_key');
    expect(postBodies()[0]).not.toHaveProperty('corrected_timestamp');
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(readPendingDirectCorrection()).toBeNull();
  });

  it('blocks an all-whitespace reason before any request', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { tree } = await render();
    await change(tree.root.findByType('textarea'), '   ');
    expect(button(tree, 'Void row').props.disabled).toBe(true);
    expect(tree.root.findByType('textarea').props.maxLength).toBe(1000);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('add mode', () => {
  it('locks a filtered worker, fixes the date, and posts an offset-free factory timestamp', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 201, json: async () => ({}) })));
    const { tree, onSaved } = await render({ mode: 'add', sourceEvent: null, lockedWorkerId: 'worker-2', effectiveEvents: [] });
    const [worker, punch] = tree.root.findAllByType('select');
    expect(worker.props.disabled).toBe(true);
    expect(worker.props.value).toBe('worker-2');
    expect(worker.findAllByType('option').map((option) => option.props.value)).toEqual(['worker-2']);
    expect(tree.root.findAllByType('input').find((input) => input.props.value === '2026-09-14')?.props.readOnly).toBe(true);
    expect(text(tree.root)).toContain('earlier (daylight time) occurrence');

    await change(punch, 'clock_out');
    await change(tree.root.findByProps({ type: 'time' }), '16:05');
    await change(tree.root.findByType('textarea'), 'Forgot to clock out; foreman confirmed 16:05');
    await change(tree.root.findAllByType('input').find((input) => input.props.placeholder === 'Optional')!, ' Dana ');
    await act(async () => button(tree, 'Add punch').props.onClick());
    expect(postBodies()).toEqual([{
      date: '2026-09-14', worker_id: 'worker-2', action: 'add_clock_out', corrected_timestamp: '2026-09-14T16:05:00',
      reason: 'Forgot to clock out; foreman confirmed 16:05', supervisor_name: 'Dana', request_id: expect.any(String),
    }]);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('requires a worker and a time and blocks future factory times', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { tree } = await render({ mode: 'add', sourceEvent: null, effectiveEvents: [] });
    await change(tree.root.findByType('textarea'), 'Missed scan');
    await act(async () => button(tree, 'Add punch').props.onClick());
    expect(alerts(tree)).toEqual(['Choose a worker.']);
    await change(tree.root.findAllByType('select')[0], 'worker-1');
    await act(async () => button(tree, 'Add punch').props.onClick());
    expect(alerts(tree)).toEqual(['Enter the time as HH:mm.']);
    await change(tree.root.findByProps({ type: 'time' }), '17:30');
    await act(async () => button(tree, 'Add punch').props.onClick());
    expect(alerts(tree)[0]).toMatch(/not happened yet/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('blocks a future date', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { tree } = await render({ mode: 'add', date: '2026-09-15', sourceEvent: null, effectiveEvents: [] });
    await change(tree.root.findAllByType('select')[0], 'worker-1');
    await change(tree.root.findByProps({ type: 'time' }), '08:00');
    await change(tree.root.findByType('textarea'), 'Missed scan');
    await act(async () => button(tree, 'Add punch').props.onClick());
    expect(alerts(tree)[0]).toMatch(/future/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['previous', '2026-09-14', '00:00', 'clock_in', '2026-09-13', '2026-09-13T23:59:00'],
    ['next', '2026-09-13', '23:59', 'clock_out', '2026-09-14', '2026-09-14T00:00:30'],
  ])('checks the %s day for a duplicate across midnight', async (_label, date, time, type, adjacentDate, adjacentTimestamp) => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      requests.push(url);
      if (init?.method === 'POST') return { ok: true, status: 201, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => [{ ...rawScan, id: 'adjacent', event_type: type, timestamp: adjacentTimestamp }] };
    }));
    const { tree } = await render({ mode: 'add', date, sourceEvent: null, effectiveEvents: [] });
    await change(tree.root.findAllByType('select')[0], 'worker-1');
    await change(tree.root.findAllByType('select')[1], type);
    await change(tree.root.findByProps({ type: 'time' }), time);
    await change(tree.root.findByType('textarea'), 'Missed scan');
    await act(async () => button(tree, 'Add punch').props.onClick());
    expect(requests).toEqual([`/api/attendance?date=${adjacentDate}&worker_id=worker-1`]);
    expect(alerts(tree).join(' ')).toContain('Possible duplicate');
    expect(alerts(tree).join(' ')).toContain(`on ${adjacentDate}`);
    expect(postBodies()).toHaveLength(0);
    await act(async () => button(tree, 'Save anyway').props.onClick());
    expect(postBodies()).toHaveLength(1);
  });

  it('does not save near midnight when the neighboring day cannot be checked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    const { tree } = await render({ mode: 'add', sourceEvent: null, effectiveEvents: [] });
    await change(tree.root.findAllByType('select')[0], 'worker-1');
    await change(tree.root.findByProps({ type: 'time' }), '00:01');
    await change(tree.root.findByType('textarea'), 'Missed scan');
    await act(async () => button(tree, 'Add punch').props.onClick());
    expect(alerts(tree)).toEqual(['Could not check the neighboring day for a possible duplicate. Try again.']);
    expect(postBodies()).toHaveLength(0);
    expect(tree.root.findByType('textarea').props.disabled).toBe(false);
  });

  it('asks for confirmation before saving a possible duplicate', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 201, json: async () => ({}) })));
    const { tree } = await render({ mode: 'add', sourceEvent: null });
    await change(tree.root.findAllByType('select')[0], 'worker-1');
    await change(tree.root.findAllByType('select')[1], 'clock_in');
    await change(tree.root.findByProps({ type: 'time' }), '08:01');
    await change(tree.root.findByType('textarea'), 'Second entry scan');
    await act(async () => button(tree, 'Add punch').props.onClick());
    expect(alerts(tree).join(' ')).toContain('Possible duplicate');
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => button(tree, 'Save anyway').props.onClick());
    expect(postBodies()).toHaveLength(1);
  });
});

describe('uncertain save recovery', () => {
  async function fillVoid(tree: ReactTestRenderer) {
    await change(tree.root.findByType('textarea'), 'Duplicate badge');
    await act(async () => button(tree, 'Void row').props.onClick());
  }

  it.each([
    ['a lost response', () => { throw new Error('connection reset'); }],
    ['a 5xx', () => ({ ok: false, status: 502, json: async () => ({ error: 'Bad gateway' }) })],
  ])('freezes the payload after %s and retries the identical request', async (_label, firstAttempt) => {
    let attempts = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) return firstAttempt();
      return { ok: true, status: 201, json: async () => ({ id: 'correction-1' }) };
    }));
    const { tree, onSaved, onPendingStart, onPendingSettled } = await render();
    await fillVoid(tree);

    expect(alerts(tree).join(' ')).toContain('Save may have completed');
    expect(onPendingSettled).not.toHaveBeenCalled();
    expect(tree.root.findByType('textarea').props.disabled).toBe(true);
    expect(tree.root.findAllByType('input').filter((input) => !input.props.readOnly).every((input) => input.props.disabled)).toBe(true);
    expect(hasButton(tree, 'Void row')).toBe(false);
    // The page lock is taken before the request is sent.
    expect(onPendingStart).toHaveBeenCalledWith(expect.objectContaining({ request_id: postBodies()[0].request_id }));
    // Edits are ignored while the outcome is unknown.
    await change(tree.root.findByType('textarea'), 'Edited');
    expect(tree.root.findByType('textarea').props.value).toBe('Duplicate badge');

    await act(async () => button(tree, 'Retry same save').props.onClick());
    const [first, second] = postBodies();
    expect(second).toEqual(first);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onPendingSettled).toHaveBeenCalledWith(first.request_id);
    expect(readPendingDirectCorrection()).toBeNull();
  });

  it('keeps the frozen payload across close and reopen', async () => {
    let attempts = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('offline');
      return { ok: true, status: 201, json: async () => ({}) };
    }));
    const first = await render();
    await fillVoid(first.tree);
    await act(async () => button(first.tree, 'Close (keep pending)').props.onClick());
    expect(first.onClose).toHaveBeenCalled();
    await act(async () => first.tree.unmount());

    const pending = readPendingDirectCorrection();
    expect(pending?.request).toMatchObject({ action: 'void_event', original_attendance_id: 'raw-1', reason: 'Duplicate badge' });
    // Reopened from a different trigger: the pending save wins.
    const reopened = await render({ mode: 'add', sourceEvent: null, pending });
    expect(reopened.tree.root.findByType('textarea').props.value).toBe('Duplicate badge');
    expect(reopened.tree.root.findByType('textarea').props.disabled).toBe(true);
    await act(async () => button(reopened.tree, 'Retry same save').props.onClick());
    const [lost, retried] = postBodies();
    expect(retried).toEqual(lost);
    expect(reopened.onSaved).toHaveBeenCalledTimes(1);
  });

  it('releases the request and unlocks editing after a definitive 4xx', async () => {
    let attempts = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('offline');
      return { ok: false, status: 409, json: async () => ({ error: 'This attendance event already has an active void; reverse that correction before voiding it again' }) };
    }));
    const { tree, onSaved, onPendingSettled } = await render();
    await fillVoid(tree);
    await act(async () => button(tree, 'Retry same save').props.onClick());
    expect(alerts(tree)).toEqual(['This attendance event already has an active void; reverse that correction before voiding it again']);
    expect(onSaved).not.toHaveBeenCalled();
    expect(onPendingSettled).toHaveBeenCalledWith(postBodies()[0].request_id);
    expect(tree.root.findByType('textarea').props.disabled).toBe(false);
    expect(readPendingDirectCorrection()).toBeNull();

    // The acknowledged ID is not reused for a fresh attempt.
    await act(async () => button(tree, 'Void row').props.onClick());
    const bodies = postBodies();
    expect(bodies).toHaveLength(3);
    expect(bodies[2].request_id).not.toBe(bodies[0].request_id);
  });

  it('shows a reopened add for another worker read-only, then rebinds to the filter after a 4xx', async () => {
    const pending = {
      request: { date: '2026-09-14', worker_id: 'worker-1', action: 'add_clock_out' as const, corrected_timestamp: '2026-09-14T16:00:00', reason: 'Forgot to clock out' },
      request_id: 'pending-a', worker_label: 'Worker One · Assembly',
    };
    let attempts = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      attempts += 1;
      return attempts === 1
        ? { ok: false, status: 400, json: async () => ({ error: 'Worker not found.' }) }
        : { ok: true, status: 201, json: async () => ({}) };
    }));
    // Reopened under ?worker_id=worker-2.
    const { tree } = await render({ mode: 'add', sourceEvent: null, lockedWorkerId: 'worker-2', effectiveEvents: [], pending });
    expect(tree.root.findAllByType('input').find((input) => input.props.value === 'Worker One · Assembly')?.props.readOnly).toBe(true);
    await act(async () => button(tree, 'Retry same save').props.onClick());
    expect(postBodies()[0]).toMatchObject({ worker_id: 'worker-1', request_id: 'pending-a' });
    expect(alerts(tree)).toEqual(['Worker not found.']);

    const [worker] = tree.root.findAllByType('select');
    expect(worker.props.value).toBe('worker-2');
    expect(worker.findAllByType('option').map((option) => option.props.value)).toEqual(['worker-2']);
    await act(async () => button(tree, 'Add punch').props.onClick());
    expect(postBodies()[1]).toMatchObject({ worker_id: 'worker-2', corrected_timestamp: '2026-09-14T16:00:00' });
    expect(postBodies()[1].request_id).not.toBe('pending-a');
  });

  it('does not double-submit while a save is in flight', async () => {
    let resolve!: (value: unknown) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((done) => { resolve = done; })));
    const { tree } = await render();
    await change(tree.root.findByType('textarea'), 'Duplicate badge');
    const save = button(tree, 'Void row').props.onClick;
    await act(async () => { save(); save(); });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(tree.root.findByType('textarea').props.disabled).toBe(true);
    expect(hasButton(tree, 'Cancel')).toBe(false);
    await act(async () => resolve({ ok: true, status: 201, json: async () => ({}) }));
  });

  it('does not submit when the page selection is no longer ready', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { tree } = await render({ ready: false });
    await change(tree.root.findByType('textarea'), 'Duplicate badge');
    expect(button(tree, 'Void row').props.disabled).toBe(true);
    await act(async () => button(tree, 'Void row').props.onClick());
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('accessible modal', () => {
  function focusable(name: string) {
    return { name, focus: vi.fn() };
  }

  it('focuses the first control, traps Tab, closes on Escape and returns focus', async () => {
    const first = focusable('first');
    const last = focusable('last');
    const trigger = focusable('trigger');
    const doc = { activeElement: last as unknown };
    vi.stubGlobal('document', doc);
    const section = {
      querySelector: () => first,
      querySelectorAll: () => [first, last],
      contains: (node: unknown) => node === first || node === last,
    };
    const onClose = vi.fn();
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(
        <AttendanceCorrectionDialog
          date="2026-09-14" mode="void" sourceEvent={rawScan} effectiveEvents={[]} ready now={now}
          returnFocusRef={{ current: trigger as unknown as HTMLElement }}
          onPendingStart={vi.fn()} onPendingSettled={vi.fn()} onSaved={vi.fn()} onClose={onClose}
        />,
        { createNodeMock: (element) => element.type === 'section' ? section : null },
      );
    });
    expect(first.focus).toHaveBeenCalled();
    const overlay = tree.root.findByProps({ role: 'dialog' });
    expect(overlay.props['aria-modal']).toBe('true');
    expect(overlay.props['aria-labelledby']).toBe('direct-correction-title');

    const tab = { key: 'Tab', shiftKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    await act(async () => overlay.props.onKeyDown(tab));
    expect(tab.preventDefault).toHaveBeenCalled();
    expect(first.focus).toHaveBeenCalledTimes(2);

    doc.activeElement = first;
    const shiftTab = { key: 'Tab', shiftKey: true, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    await act(async () => overlay.props.onKeyDown(shiftTab));
    expect(last.focus).toHaveBeenCalled();

    await act(async () => overlay.props.onKeyDown({ key: 'Escape', shiftKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn() }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => tree.unmount());
    expect(trigger.focus).toHaveBeenCalled();
  });

  it('lets Escape close a hanging save while keeping it pending for an identical retry', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const { tree, onClose, onPendingStart } = await render();
    await change(tree.root.findByType('textarea'), 'Duplicate badge');
    await act(async () => { button(tree, 'Void row').props.onClick(); });
    expect(button(tree, 'Close').props.disabled).toBeFalsy();
    await act(async () => tree.root.findByProps({ role: 'dialog' }).props.onKeyDown({ key: 'Escape', stopPropagation: vi.fn() }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPendingStart).toHaveBeenCalledTimes(1);
    expect(readPendingDirectCorrection()?.request_id).toBe(postBodies()[0].request_id);
  });

  it('reports a definitive rejection that arrives after the dialog closed', async () => {
    let reject!: (value: unknown) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { reject = resolve; })));
    const onRejectedAfterClose = vi.fn();
    const { tree, onPendingSettled } = await render({ onRejectedAfterClose });
    await change(tree.root.findByType('textarea'), 'Duplicate badge');
    await act(async () => { button(tree, 'Void row').props.onClick(); });
    await act(async () => button(tree, 'Close').props.onClick());
    await act(async () => tree.unmount());
    await act(async () => reject({ ok: false, status: 409, json: async () => ({ error: 'Already voided' }) }));
    expect(onRejectedAfterClose).toHaveBeenCalledWith('Already voided');
    expect(onPendingSettled).toHaveBeenCalled();
    expect(readPendingDirectCorrection()).toBeNull();
  });
});
