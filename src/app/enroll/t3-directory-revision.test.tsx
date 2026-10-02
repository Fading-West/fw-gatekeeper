import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'enrollment' }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
import EnrollPage from './page';
let tree: ReactTestRenderer | undefined;
const label = (node: any): string => typeof node === 'string' ? node : (node?.children || []).map(label).join('');
const button = (text: string) => tree!.root.findAllByType('button').find(node => label(node).includes(text))!;
afterEach(async () => { if (tree) await act(async () => tree!.unmount()); tree = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });
it('loads the current identity for directory-selected re-enrollment before opening the camera and carries its revision', async () => {
  vi.useFakeTimers();
  let resolve!: (response: Response) => void;
  const current = new Promise<Response>(done => { resolve = done; });
  const directory = { suggestions: [{ name: 'Directory name', employeeId: 'S-1', department: 'Old department', status: 'enrolled', workerId: 'synthetic-worker' }], summary: { total: 1, enrolled: 1, remaining: 0, invalid: 0 } };
  const requests = vi.fn((url: string, _options?: RequestInit) => url.startsWith('/api/workers?id=') ? current : Promise.resolve(Response.json(url === '/api/enroll' ? { photosCount: 3 } : directory)));
  vi.stubGlobal('fetch', requests);
  const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] });
  const video = { readyState: 2, videoWidth: 1280, videoHeight: 720, srcObject: null };
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ drawImage: vi.fn() }), toDataURL: () => 'data:image/jpeg;base64,photo' }) });
  await act(async () => { tree = create(<EnrollPage />, { createNodeMock: node => node.type === 'video' ? video : null }); });
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  await act(async () => button('Directory name').props.onClick());
  expect(button('Continue to Re-enrollment').props.disabled).toBe(true);
  await act(async () => button('Continue to Re-enrollment').props.onClick());
  expect(getUserMedia).not.toHaveBeenCalled();
  await act(async () => resolve(Response.json({ name: 'Current name', employee_id: 'S-1', department: 'Current department', identity_revision: 'captured-revision' })));
  expect(tree!.root.findByProps({ id: 'employee-name' }).props.value).toBe('Current name');
  expect(button('Continue to Re-enrollment').props.disabled).toBe(false);
  await act(async () => button('Continue to Re-enrollment').props.onClick());
  await act(async () => tree!.root.findByType('video').props.onLoadedData());
  await act(async () => tree!.root.findByProps({ id: 'biometric-consent' }).props.onChange({ target: { checked: true } }));
  await act(async () => button('Start Capture').props.onClick());
  await act(async () => { await vi.advanceTimersByTimeAsync(3500); });
  const submitted = requests.mock.calls.find(([url]) => url === '/api/enroll');
  expect(submitted).toBeDefined();
  expect(JSON.parse(submitted![1]!.body as string)).toMatchObject({ workerId: 'synthetic-worker', expected_identity_revision: 'captured-revision', name: 'Current name', department: 'Current department' });
});

it('recovers an identity conflict through Try Again and captures against the newly loaded revision', async () => {
  vi.useFakeTimers();
  const directory = { suggestions: [{ name: 'Directory name', employeeId: 'S-1', department: 'Old department', status: 'enrolled', workerId: 'synthetic-worker' }], summary: { total: 1, enrolled: 1, remaining: 0, invalid: 0 } };
  const posts: Array<Record<string, unknown>> = [];
  let identityReads = 0;
  let resolveCurrent!: (response: Response) => void;
  const current = new Promise<Response>(done => { resolveCurrent = done; });
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    if (url.startsWith('/api/workers?id=')) {
      identityReads++;
      return identityReads === 1 ? Promise.resolve(Response.json({ name: 'Original name', employee_id: 'S-1', department: 'Mill', identity_revision: 'original-revision' })) : current;
    }
    if (url === '/api/enroll') {
      posts.push(JSON.parse(options!.body as string));
      return Promise.resolve(posts.length === 1 ? Response.json({ error: 'Worker identity changed. Reload enrollment before capturing new photos.', code: 'WORKER_IDENTITY_CONFLICT' }, { status: 409 }) : Response.json({ photosCount: 3 }));
    }
    return Promise.resolve(Response.json(directory));
  }));
  const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] });
  const video = { readyState: 2, videoWidth: 1280, videoHeight: 720, srcObject: null };
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ drawImage: vi.fn() }), toDataURL: () => 'data:image/jpeg;base64,photo' }) });
  await act(async () => { tree = create(<EnrollPage />, { createNodeMock: node => node.type === 'video' ? video : null }); });
  await act(async () => tree!.root.findByProps({ id: 'employee-name' }).props.onChange({ target: { value: 'Directory' } }));
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  await act(async () => button('Directory name').props.onClick());
  const capture = async () => {
    await act(async () => button('Continue to Re-enrollment').props.onClick());
    await act(async () => tree!.root.findByType('video').props.onLoadedData());
    await act(async () => tree!.root.findByProps({ id: 'biometric-consent' }).props.onChange({ target: { checked: true } }));
    await act(async () => button('Start Capture').props.onClick());
    await act(async () => { await vi.advanceTimersByTimeAsync(3500); });
  };
  await capture();
  expect(posts[0]).toMatchObject({ expected_identity_revision: 'original-revision' });
  expect(label(tree!.toJSON())).toContain('Worker identity changed');
  await act(async () => button('Try Again').props.onClick());
  expect(identityReads).toBe(2);
  expect(button('Continue to Re-enrollment').props.disabled).toBe(true);
  await act(async () => button('Continue to Re-enrollment').props.onClick());
  expect(getUserMedia).toHaveBeenCalledTimes(1);
  await act(async () => resolveCurrent(Response.json({ name: 'Current name', employee_id: 'S-1', department: 'Current department', identity_revision: 'current-revision' })));
  expect(button('Continue to Re-enrollment').props.disabled).toBe(false);
  await capture();
  expect(posts).toHaveLength(2);
  expect(posts[1]).toMatchObject({ workerId: 'synthetic-worker', name: 'Current name', department: 'Current department', expected_identity_revision: 'current-revision' });
  expect(label(tree!.toJSON())).toContain('Face encoding saved');
});
