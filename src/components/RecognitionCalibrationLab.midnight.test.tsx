import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import RecognitionCalibrationLab from './RecognitionCalibrationLab';

// Opened from the sidebar: no ?date= in the URL, so the page starts on factory today.
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('') }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'admin' }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
const label = (node: any): string => typeof node === 'string' ? node : (node?.children || []).map(label).join('');
const payload = (date: string) => ({
  attempts: [{ id: `attempt-${date}`, candidate_worker_name: `Worker ${date}`, kiosk_id: 'gate-1', timestamp: `${date}T08:00:00`, decision: 'near_miss', review_status: 'unreviewed' }],
  summary: { total: 1 },
});
let tree: ReactTestRenderer;
let requests: Map<string, (data: unknown) => void>;
let fetchMock: ReturnType<typeof vi.fn>;
const dateInput = () => tree.root.findAllByType('input').find((node) => node.props.type === 'date')!;
const reviewSelect = () => tree.root.findAllByType('select')[1];
const requestedDates = () => fetchMock.mock.calls.map(([url]) => new URL(url, 'http://localhost').searchParams.get('date'));

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // 23:50 on October 11 in America/Chicago.
  vi.setSystemTime(new Date('2026-10-12T04:50:00Z'));
  requests = new Map();
  fetchMock = vi.fn().mockImplementation((url: string) => new Promise((resolve) => {
    requests.set(url, (data) => resolve({ ok: true, json: async () => data }));
  }));
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => { tree = create(<RecognitionCalibrationLab />); });
});

afterEach(async () => {
  await act(async () => tree.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('keeps the chosen date and filters after factory midnight', async () => {
  expect(dateInput().props.value).toBe('2026-10-11');
  await act(async () => dateInput().props.onChange({ target: { value: '2026-10-09' } }));
  await act(async () => reviewSelect().props.onChange({ target: { value: 'unreviewed' } }));
  const selected = '/api/recognition-attempts?date=2026-10-09&limit=150&review_status=unreviewed';
  expect(requests.has(selected)).toBe(true);

  // Factory midnight passes while the supervisor works the backlog; the next
  // render (here, the selected day's results arriving) must not reset the view.
  vi.setSystemTime(new Date('2026-10-12T05:00:30Z'));
  await act(async () => requests.get(selected)!(payload('2026-10-09')));
  await act(async () => { vi.advanceTimersByTime(30_000); });

  expect(dateInput().props.value).toBe('2026-10-09');
  expect(reviewSelect().props.value).toBe('unreviewed');
  expect(label(tree.toJSON())).toContain('Worker 2026-10-09');
  expect(label(tree.toJSON())).toContain('A new factory day has started (2026-10-12)');
  expect(requestedDates()).not.toContain('2026-10-12');
});

it('still follows factory today when nothing was chosen', async () => {
  vi.setSystemTime(new Date('2026-10-12T05:00:30Z'));
  await act(async () => { vi.advanceTimersByTime(30_000); });
  expect(dateInput().props.value).toBe('2026-10-12');
  expect(requestedDates()).toContain('2026-10-12');
});
