import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import BriefingPage from './briefing/page';
import ExceptionsPage from './exceptions/page';
import WorkersPage from './workers/page';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('') }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'admin' }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

let tree: ReactTestRenderer | undefined;
function text(node: any): string {
  return typeof node === 'string' ? node : (node?.children || []).map(text).join('');
}
afterEach(async () => {
  if (tree) await act(async () => tree!.unmount());
  tree = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([
  { name: 'Briefing', Page: BriefingPage, hasRefresh: true },
  { name: 'Exceptions', Page: ExceptionsPage, hasRefresh: true },
  { name: 'Workers', Page: WorkersPage, hasRefresh: false },
])('$name exposes the error after a stalled response body', async ({ Page, hasRefresh }) => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/kiosks') return Response.json([]);
    return { ok: true, json: () => new Promise(() => {}) };
  }));
  await act(async () => { tree = create(<Page />); });
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(JSON.stringify(tree!.toJSON())).toContain('Live data request timed out. Try refreshing again.');
  if (hasRefresh) {
    const retry = tree!.root.findAllByType('button').find((button) => /Refresh|Retry|Try again/i.test(text(button)));
    expect(retry).toBeDefined();
    expect(retry!.props.disabled).toBeFalsy();
  }
});
