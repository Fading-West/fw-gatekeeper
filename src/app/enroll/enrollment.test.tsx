import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EnrollPage from './page';

const mocks = vi.hoisted(() => ({ replace: vi.fn(), role: 'admin' }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }), useSearchParams: () => new URLSearchParams() }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => mocks.role }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));

let tree: ReactTestRenderer;
let stop: ReturnType<typeof vi.fn>;
let getUserMedia: ReturnType<typeof vi.fn>;
let video: { readyState: number; videoWidth: number; videoHeight: number; srcObject: unknown };
let fetchMock: ReturnType<typeof vi.fn>;
const label = (node: any): string => typeof node === 'string' ? node : (node?.children || []).map(label).join('');
const button = (text: string) => tree.root.findAllByType('button').find((node) => label(node).includes(text))!;
async function click(text: string) { await act(async () => { button(text).props.onClick(); }); }

beforeEach(async () => {
  mocks.role = 'admin';
  vi.useFakeTimers();
  stop = vi.fn();
  getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] });
  video = { readyState: 0, videoWidth: 0, videoHeight: 0, srcObject: null };
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }), toDataURL: () => 'data:image/jpeg;base64,photo' }) });
  fetchMock = vi.fn().mockImplementation(async (url) => ({ ok: true, json: async () => url === '/api/enroll' ? { photosCount: 3 } : { suggestions: [], summary: { total: 2, enrolled: 1, remaining: 1, invalid: 0 } } }));
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => { tree = create(<EnrollPage />, { createNodeMock: (element) => element.type === 'video' ? video : null }); });
  await click('Add manually');
  const name = tree.root.findAllByType('input').find((node) => node.props.id === 'employee-name')!;
  await act(async () => { name.props.onChange({ target: { value: 'Alex Smith' } }); });
});
afterEach(async () => { await act(async () => tree.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

async function confirmConsent() {
  await act(async () => tree.root.findAllByType('input').find((node) => node.props.id === 'biometric-consent')!.props.onChange({ target: { checked: true } }));
}

async function readyCamera() {
  await click('Continue to Camera');
  video.readyState = 2; video.videoWidth = 1280; video.videoHeight = 720;
  await act(async () => tree.root.findByType('video').props.onLoadedData());
  await confirmConsent();
}

describe('enrollment lifecycle', () => {
  it('waits for real frames and starts a fresh employee after completion', async () => {
    await click('Continue to Camera');
    expect(button('Waiting for camera').props.disabled).toBe(true);
    video.readyState = 2; video.videoWidth = 1280; video.videoHeight = 720;
    await act(async () => tree.root.findByType('video').props.onLoadedData());
    expect(button('Start Capture').props.disabled).toBe(true);
    await click('Start Capture');
    expect(tree.root.findAllByType('input').some((node) => node.props.id === 'biometric-consent')).toBe(true);
    await confirmConsent();
    await click('Start Capture');
    await act(async () => { await vi.advanceTimersByTimeAsync(3500); });
    expect(stop).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/enroll')).toHaveLength(1);
    await click('Enroll Next Employee');
    expect(button('Continue to Camera').props.disabled).toBe(true);
    expect(tree.root.findAllByType('input').every((node) => !node.props.value)).toBe(true);
    expect(mocks.replace).toHaveBeenCalledWith('/enroll');
    await click('Add manually');
    await act(async () => tree.root.findAllByType('input').find((node) => node.props.id === 'employee-name')!.props.onChange({ target: { value: 'Next Worker' } }));
    await click('Continue to Camera');
    await act(async () => tree.root.findByType('video').props.onLoadedData());
    expect(tree.root.findAllByType('input').find((node) => node.props.id === 'biometric-consent')!.props.checked).toBe(false);
    expect(button('Start Capture').props.disabled).toBe(true);
    const submission = fetchMock.mock.calls.find(([url]) => url === '/api/enroll');
    expect(JSON.parse(submission![1].body).consent).toBe(true);
  });

  it('stops a camera granted after navigation and ignores duplicate permission requests', async () => {
    let resolve!: (value: unknown) => void;
    getUserMedia.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await click('Continue to Camera');
    await click('Opening camera');
    expect(getUserMedia).toHaveBeenCalledOnce();
    await act(async () => tree.unmount());
    await act(async () => resolve({ getTracks: () => [{ stop }] }));
    expect(stop).toHaveBeenCalledOnce();
  });

  it('requires new consent after going back and changing the employee', async () => {
    await readyCamera();
    await click('Back');
    await act(async () => tree.root.findAllByType('input').find((node) => node.props.id === 'employee-name')!.props.onChange({ target: { value: 'Another Worker' } }));
    await click('Continue to Camera');
    await act(async () => tree.root.findByType('video').props.onLoadedData());
    expect(tree.root.findAllByType('input').find((node) => node.props.id === 'biometric-consent')!.props.checked).toBe(false);
    expect(button('Start Capture').props.disabled).toBe(true);
  });

  it('recovers if video stops during capture instead of hanging or submitting blanks', async () => {
    await readyCamera();
    await click('Start Capture');
    video.readyState = 0;
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(label(tree.toJSON())).toContain('camera stopped providing images');
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/enroll')).toBe(false);
    expect(stop).toHaveBeenCalledOnce();
  });
});


describe('enrollment access loss', () => {
  async function changeRole(role: string | undefined) {
    mocks.role = role as string;
    await act(async () => { tree.update(<EnrollPage />); });
  }

  it('releases a late permission grant after downgrade and requires a fresh camera on regrant', async () => {
    let resolve!: (value: unknown) => void;
    getUserMedia.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await click('Continue to Camera');
    await changeRole('viewer');
    await changeRole('admin');
    await act(async () => resolve({ getTracks: () => [{ stop }] }));
    expect(stop).toHaveBeenCalledOnce();
    expect(tree.root.findAllByType('video')).toHaveLength(0);
    expect(button('Continue to Camera').props.disabled).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/enroll')).toBe(false);
  });

  it('stops the preview and clears consent when resolved membership disappears', async () => {
    await readyCamera();
    await changeRole(undefined);
    expect(stop).toHaveBeenCalledOnce();
    await changeRole('enrollment');
    expect(tree.root.findAllByType('video')).toHaveLength(0);
    expect(tree.root.findAllByType('input').every((node) => !node.props.value)).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/enroll')).toBe(false);
  });

  it('cancels capture and rejects a saved capture callback after role loss', async () => {
    await readyCamera();
    const staleCapture = button('Start Capture').props.onClick;
    await click('Start Capture');
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    await changeRole('viewer');
    await act(async () => { staleCapture(); await vi.advanceTimersByTimeAsync(9000); });
    expect(stop).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/enroll')).toBe(false);
    await changeRole('admin');
    expect(tree.root.findAllByType('video')).toHaveLength(0);
    expect(label(tree.toJSON())).not.toContain('photos captured');
  });

  it('aborts a processing request and ignores its late response even after regrant', async () => {
    let resolve!: (value: unknown) => void;
    const normalFetch = fetchMock.getMockImplementation()! as (...args: any[]) => any;
    fetchMock.mockImplementation((url, options) => url === '/api/enroll'
      ? new Promise((done) => { resolve = done; }) : normalFetch(url, options));
    await readyCamera();
    await click('Start Capture');
    await act(async () => { await vi.advanceTimersByTimeAsync(3500); });
    const request = fetchMock.mock.calls.find(([url]) => url === '/api/enroll')!;
    expect(request).toBeTruthy();
    await changeRole('viewer');
    expect(request[1].signal.aborted).toBe(true);
    await changeRole('admin');
    await act(async () => resolve({ ok: true, json: async () => ({ photosCount: 3 }) }));
    expect(label(tree.toJSON())).not.toContain('Face encoding saved');
    expect(tree.root.findAllByType('video')).toHaveLength(0);
    expect(button('Continue to Camera').props.disabled).toBe(true);
  });

  it('rejects an old capture callback after regrant and a new preview without fresh consent', async () => {
    await readyCamera();
    const staleCapture = button('Start Capture').props.onClick;
    await changeRole('viewer');
    await changeRole('admin');
    await act(async () => tree.root.findAllByType('input').find((node) => node.props.id === 'employee-name')!
      .props.onChange({ target: { value: 'New worker' } }));
    await click('Continue to Camera');
    await act(async () => tree.root.findByType('video').props.onLoadedData());
    await act(async () => { staleCapture(); await vi.advanceTimersByTimeAsync(9000); });
    expect(button('Start Capture').props.disabled).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/enroll')).toBe(false);
    await confirmConsent();
    await act(async () => { staleCapture(); await vi.advanceTimersByTimeAsync(9000); });
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/enroll')).toBe(false);
    await click('Start Capture');
    await act(async () => { await vi.advanceTimersByTimeAsync(3500); });
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/enroll')).toBe(true);
  });
});
