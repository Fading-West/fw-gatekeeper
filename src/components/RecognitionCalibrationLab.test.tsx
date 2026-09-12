import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import RecognitionCalibrationLab from './RecognitionCalibrationLab';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('date=2026-09-10') }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'admin' }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
const label = (node: any): string => typeof node === 'string' ? node : (node?.children || []).map(label).join('');
const payload = (id: string, name: string) => ({ attempts: [{ id, candidate_worker_name: name, kiosk_id: 'gate-1', timestamp: '2026-09-10T08:00:00', decision: 'accepted', review_status: 'unreviewed' }], summary: { total: 1 } });
let tree: ReactTestRenderer;
let requests: Map<string, (data: unknown, ok?: boolean) => void>;
let fetchMock: ReturnType<typeof vi.fn>;
const button = (text: string) => tree.root.findAllByType('button').find((node) => label(node) === text)!;
const day = (date: string) => `/api/recognition-attempts?date=${date}&limit=150`;

beforeEach(async () => {
  requests = new Map();
  fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => new Promise((resolve) => requests.set(init?.method === 'PATCH' ? 'PATCH' : url, (data, ok = true) => resolve({ ok, json: async () => data }))));
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => { tree = create(<RecognitionCalibrationLab />); });
});
afterEach(async () => { await act(async () => tree.unmount()); vi.unstubAllGlobals(); });
async function selectDate(date: string) {
  await act(async () => tree.root.findAllByType('input').find((node) => node.props.type === 'date')!.props.onChange({ target: { value: date } }));
}

it('keeps the selected date when an old request finishes last', async () => {
  await selectDate('2026-09-11');
  await act(async () => requests.get(day('2026-09-11'))!(payload('new', 'Friday worker')));
  await act(async () => requests.get(day('2026-09-10'))!(payload('old', 'Thursday worker')));
  expect(label(tree.toJSON())).toContain('Friday worker');
  expect(label(tree.toJSON())).not.toContain('Thursday worker');
});

it('rejects a stale review handler after changing the filter selection', async () => {
  await act(async () => requests.get(day('2026-09-10'))!(payload('old', 'Thursday worker')));
  const staleReview = button('Confirm').props.onClick;
  await selectDate('2026-09-11');
  expect(tree.root.findAllByType('button').some((node) => label(node) === 'Confirm')).toBe(false);
  await act(async () => staleReview());
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
});

it('deduplicates reviews and never refreshes old filters after a pending review finishes', async () => {
  await act(async () => requests.get(day('2026-09-10'))!(payload('old', 'Thursday worker')));
  const review = button('Confirm').props.onClick;
  await act(async () => { review(); review(); });
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
  expect(button('Confirm').props.disabled).toBe(true);
  await selectDate('2026-09-11');
  await act(async () => requests.get(day('2026-09-11'))!(payload('new', 'Friday worker')));
  expect(button('Confirm').props.disabled).toBe(true);
  await act(async () => requests.get('PATCH')!({}));
  expect(label(tree.toJSON())).toContain('Friday worker');
  expect(button('Confirm').props.disabled).toBe(false);
  expect(fetchMock.mock.calls.filter(([url]) => url === day('2026-09-10'))).toHaveLength(1);
});

it('shows a failed request without claiming there were no attempts', async () => {
  await act(async () => requests.get(day('2026-09-10'))!({ error: 'Source unavailable' }, false));
  expect(label(tree.toJSON())).toContain('Source unavailable');
  expect(label(tree.toJSON())).not.toContain('No recognition attempts match');
});
