import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import LogPage from './page';

const mocks = vi.hoisted(() => ({ toast: vi.fn(), date: '2026-11-05' }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams({ date: mocks.date }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'admin' }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));

let tree: ReactTestRenderer | undefined;
function text(node: ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(text).join('');
}
function button(label: string) {
  return tree!.root.findAllByType('button').find(node => text(node) === label)!;
}
function ready(url: string) {
  return Response.json(url.startsWith('/api/attendance-corrections') ? { corrections: [] } : []);
}
async function mount() {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  await act(async () => { tree = create(<LogPage />); });
}
afterEach(async () => {
  if (tree) await act(async () => tree!.unmount());
  tree = undefined;
  mocks.toast.mockClear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([
  ['/api/attendance?', 'request'], ['/api/attendance?', 'body'],
  ['/api/attendance-corrections?', 'request'], ['/api/attendance-corrections?', 'body'],
])('releases a stalled %s %s and ignores late completion after retry', async (path, stage) => {
  let resolve!: (value: any) => void;
  const stalled = new Promise<any>(yes => { resolve = yes; });
  let stalledSignal: AbortSignal | undefined;
  let stall = true;
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    if (stall && url.startsWith(path)) {
      stalledSignal = options?.signal as AbortSignal;
      return stage === 'request' ? stalled : Promise.resolve({ ok: true, json: () => stalled });
    }
    return Promise.resolve(ready(url));
  }));
  await mount();
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(JSON.stringify(tree!.toJSON())).toContain('Live data request timed out');
  expect(stalledSignal?.aborted).toBe(true);
  expect(button('Export CSV').props.disabled).toBe(true);
  stall = false;
  await act(async () => { button('Retry').props.onClick(); });
  expect(button('Export CSV').props.disabled).toBe(false);
  await act(async () => { resolve(stage === 'request' ? ready(path) : []); });
  expect(button('Export CSV').props.disabled).toBe(false);
  expect(JSON.stringify(tree!.toJSON())).not.toContain('Live data request timed out');
});

it.each(['request', 'body'])('releases a stalled hours neighbor %s without downloading and allows retry', async (stage) => {
  let resolve!: (value: any) => void;
  const stalled = new Promise<any>(yes => { resolve = yes; });
  let stall = true;
  const signals: AbortSignal[] = [];
  const download = vi.fn();
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    if (url.startsWith('/api/attendance?') && !url.includes(mocks.date)) {
      if (options?.signal) signals.push(options.signal);
      if (stall) return stage === 'request' ? stalled : Promise.resolve({ ok: true, json: () => stalled });
    }
    return Promise.resolve(ready(url));
  }));
  await mount();
  // Minimal download DOM; a failed export must never reach it.
  vi.stubGlobal('document', { createElement: () => ({ click: download }) });
  let exporting!: Promise<void>;
  await act(async () => { exporting = button('Export hours CSV').props.onClick(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(button('Export hours CSV').props.disabled).toBe(false);
  expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('Export cancelled'), 'error');
  expect(signals.every(signal => signal.aborted)).toBe(true);
  expect(download).not.toHaveBeenCalled();
  await act(async () => { resolve(stage === 'request' ? Response.json([]) : []); await exporting; });
  expect(download).not.toHaveBeenCalled();
  stall = false;
  await act(async () => { await button('Export hours CSV').props.onClick(); });
  expect(download).toHaveBeenCalledTimes(1);
});

it('releases a stalled worker picker and lets the operator retry', async () => {
  let stall = true;
  let signal: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    if (stall && url.startsWith('/api/workers')) {
      signal = options?.signal as AbortSignal;
      return Promise.resolve({ ok: true, json: () => new Promise(() => {}) });
    }
    return Promise.resolve(ready(url));
  }));
  await mount();
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(signal?.aborted).toBe(true);
  expect(JSON.stringify(tree!.toJSON())).toContain('Could not load the worker list.');
  stall = false;
  await act(async () => { button('Retry').props.onClick(); });
  expect(JSON.stringify(tree!.toJSON())).toContain('No selectable workers for this date.');
});

it('aborts obsolete log reads when navigating to another date', async () => {
  let resolve!: (value: any) => void;
  const stalled = new Promise<any>(yes => { resolve = yes; });
  const signals: AbortSignal[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    if (url.includes(mocks.date)) {
      if (options?.signal) signals.push(options.signal);
      return stalled;
    }
    return Promise.resolve(ready(url));
  }));
  await mount();
  await act(async () => {
    tree!.root.findByType('input').props.onChange({ target: { value: '2026-11-04' } });
  });
  expect(signals.every(signal => signal.aborted)).toBe(true);
  expect(button('Export CSV').props.disabled).toBe(false);
  await act(async () => { resolve(Response.json([])); });
  expect(button('Export CSV').props.disabled).toBe(false);
});
