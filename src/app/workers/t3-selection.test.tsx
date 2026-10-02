import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ role: 'admin' as string | undefined }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => state.role }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
import WorkersPage from './page';
function deferred() { let resolve!: (value: Response) => void; let reject!: (error: Error) => void; const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function worker(name: string, active = 1) { return { id: name, name, department: 'Synthetic', photo_url: null, enrolled_at: '2026-10-02T08:00:00Z', active }; }
let tree: ReactTestRenderer | undefined;
afterEach(async () => { if (tree) await act(async () => tree!.unmount()); tree = undefined; vi.unstubAllGlobals(); state.role = 'admin'; });
it('suppresses an inactive response after a role downgrade and aborts its request', async () => {
  const inactive = deferred(); let inactiveSignal: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    if (url === '/api/kiosks') return Promise.resolve(Response.json([]));
    if (url.includes('active=false')) { inactiveSignal = options?.signal as AbortSignal; return inactive.promise; }
    return Promise.resolve(Response.json([worker('Active synthetic')]));
  }));
  await act(async () => { tree = create(<WorkersPage />); });
  await act(async () => tree!.root.findAllByType('input').find(input => input.props.type === 'checkbox')!.props.onChange({ target: { checked: true } }));
  state.role = 'viewer';
  await act(async () => tree!.update(<WorkersPage />));
  expect(inactiveSignal?.aborted).toBe(true);
  await act(async () => inactive.resolve(Response.json([worker('Private inactive synthetic', 0)])));
  expect(JSON.stringify(tree!.toJSON())).not.toContain('Private inactive synthetic');
  expect(JSON.stringify(tree!.toJSON())).toContain('Active synthetic');
});
it('keeps the latest active result when an older inactive request fails', async () => {
  const inactive = deferred();
  vi.stubGlobal('fetch', vi.fn((url: string) => url === '/api/kiosks' ? Promise.resolve(Response.json([])) : url.includes('active=false') ? inactive.promise : Promise.resolve(Response.json([worker('Current synthetic')]))));
  await act(async () => { tree = create(<WorkersPage />); });
  const toggle = () => tree!.root.findAllByType('input').find(input => input.props.type === 'checkbox')!;
  await act(async () => toggle().props.onChange({ target: { checked: true } }));
  await act(async () => toggle().props.onChange({ target: { checked: false } }));
  await act(async () => inactive.reject(new Error('old request failed')));
  expect(JSON.stringify(tree!.toJSON())).toContain('Current synthetic');
  expect(JSON.stringify(tree!.toJSON())).not.toContain('old request failed');
});
