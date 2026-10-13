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

it('shows full-selection counts and warns that older attempts are hidden', async () => {
  await act(async () => requests.get(day('2026-09-10'))!({ ...payload('new', 'Worker'), summary: { accepted: 151, review_backlog: 1, total: 151 }, truncated: true, summary_limited: false }));
  expect(label(tree.toJSON())).toContain('Review backlog1');
  expect(label(tree.toJSON())).toContain('Showing 1 of 151 matching attempts. Results are capped');
  expect(label(tree.toJSON())).toContain('Summary counts include all matching attempts.');
  expect(label(tree.toJSON())).toContain('select Unreviewed');
});

it('labels incomplete counts as lower bounds and explains a zero backlog', async () => {
  await act(async () => requests.get(day('2026-09-10'))!({ ...payload('new', 'Worker'), summary: { accepted: 1000, review_backlog: 0, total: 1000, median_score: null }, truncated: true, summary_limited: true }));
  expect(label(tree.toJSON())).toContain('Accepted1000+');
  expect(label(tree.toJSON())).toContain('Review backlog0+');
  expect(label(tree.toJSON())).toContain('0+ does not mean there are no unresolved attempts.');
  expect(label(tree.toJSON())).toContain('Median score is unavailable');
});

it('keeps capped empty selections distinct from an exact empty selection', async () => {
  await act(async () => requests.get(day('2026-09-10'))!({ attempts: [], summary: { total: 0 }, truncated: true, summary_limited: true }));
  expect(label(tree.toJSON())).toContain('No matching attempts were found within the capped results.');
  expect(label(tree.toJSON())).not.toContain('No recognition attempts match these filters yet.');
});


it('reveals the full window before advancing and resets the cursor when filters change', async () => {
  await act(async () => requests.get(day('2026-09-10'))!({ ...payload('first', 'First worker'), summary: { total: 1000, review_backlog: 1000 }, truncated: true, summary_limited: true, next_scan_cursor: 'cursor-1' }));
  expect(button('Next scan window').props.disabled).toBe(true);
  await act(async () => button('Show all matches in this window').props.onClick());
  const fullWindow = '/api/recognition-attempts?date=2026-09-10&limit=1000';
  await act(async () => requests.get(fullWindow)!({ ...payload('first', 'First worker'), summary: { total: 1 }, truncated: true, summary_limited: true, next_scan_cursor: 'cursor-1' }));
  expect(button('Next scan window').props.disabled).toBe(false);
  await act(async () => button('Next scan window').props.onClick());
  const nextWindow = `${day('2026-09-10')}&scan_cursor=cursor-1`;
  expect(requests.has(nextWindow)).toBe(true);
  await act(async () => requests.get(nextWindow)!({ ...payload('last', 'Last worker'), summary: { total: 1 }, truncated: true, summary_limited: true, next_scan_cursor: null }));
  expect(label(tree.toJSON())).toContain('Last worker');
  expect(label(tree.toJSON())).toContain('1+ matching attempts');
  expect(button('First scan window')).toBeTruthy();
  expect(button('Next scan window')).toBeUndefined();
  expect(label(tree.toJSON())).toContain('This is the last scan window.');
  await selectDate('2026-09-11');
  expect(requests.has(day('2026-09-11'))).toBe(true);
  expect(fetchMock.mock.calls.at(-1)![0]).not.toContain('scan_cursor');
});

it('allows advancing an empty scan window without claiming the selection is empty', async () => {
  await act(async () => requests.get(day('2026-09-10'))!({ attempts: [], summary: { total: 0 }, truncated: true, summary_limited: true, next_scan_cursor: 'cursor-1' }));
  expect(button('Next scan window').props.disabled).toBe(false);
  expect(label(tree.toJSON())).toContain('even when this window is empty');
  await act(async () => button('Next scan window').props.onClick());
  expect(requests.has(`${day('2026-09-10')}&scan_cursor=cursor-1`)).toBe(true);
});

it('starts from the first window when returning to a previous filter selection', async () => {
  await act(async () => requests.get(day('2026-09-10'))!({ attempts: [], summary: { total: 0 }, truncated: true, summary_limited: true, next_scan_cursor: 'cursor-1' }));
  await act(async () => button('Next scan window').props.onClick());
  await act(async () => requests.get(`${day('2026-09-10')}&scan_cursor=cursor-1`)!(payload('last', 'Last worker')));
  await selectDate('2026-09-11');
  await act(async () => requests.get(day('2026-09-11'))!(payload('other', 'Other worker')));
  await selectDate('2026-09-10');
  expect(fetchMock.mock.calls.at(-1)![0]).toBe(day('2026-09-10'));
});

it('shows exact counts without plus signs for a complete selection', async () => {
  await act(async () => requests.get(day('2026-09-10'))!({ ...payload('only', 'Worker'), summary: { total: 1, accepted: 1, review_backlog: 1 }, truncated: false, summary_limited: false }));
  expect(label(tree.toJSON())).toContain('Review backlog1');
  expect(label(tree.toJSON())).not.toContain('1+');
  expect(button('Next scan window')).toBeUndefined();
});


it('leaves counts proven exact by filters unmarked while marking bounded counts', async () => {
  await act(async () => requests.get(day('2026-09-10'))!({ ...payload('first', 'Worker'), summary: { total: 1000, accepted: 1000, rejected: 0, review_backlog: 0 }, truncated: true, summary_limited: true,
    summary_limited_fields: ['accepted', 'low_margin_accepted', 'total'], next_scan_cursor: 'cursor-1' }));
  expect(label(tree.toJSON())).toContain('Accepted1000+');
  expect(label(tree.toJSON())).toContain('Rejected0');
  expect(label(tree.toJSON())).not.toContain('Rejected0+');
  expect(label(tree.toJSON())).not.toContain('Review backlog0+');
});
