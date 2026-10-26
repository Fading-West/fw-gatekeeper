/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import type { FunctionReference } from 'convex/server';
import { NextRequest } from 'next/server';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import schema from '../../convex/schema';
import convex from '@/lib/convex';
import { GET, PATCH } from '@/app/api/recognition-attempts/route';
import RecognitionCalibrationLab from './RecognitionCalibrationLab';

const navigation = vi.hoisted(() => ({ query: '' }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(navigation.query) }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'admin' }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/lib/convex', () => ({ default: { query: vi.fn(), mutation: vi.fn() } }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: vi.fn(async () => true) }));

const modules = import.meta.glob('../../convex/**/*.ts');
const date = '2026-09-14';
let tree: ReactTestRenderer | undefined;
let targetId: string;
let otherId: string;
let fetchMock: Mock<(url: string, init?: RequestInit) => Promise<Response>>;
let requests: Promise<Response>[];
let scrollIntoView: ReturnType<typeof vi.fn>;
const text = (node: ReactTestInstance | null | string): string => typeof node === 'string' ? node : (node?.children || []).map(text).join('');
const button = (label: string) => tree!.root.findAllByType('button').find(node => text(node) === label)!;
const field = (name: string) => tree!.root.findAllByType('label').find(node => text(node).startsWith(name))!.find(node => node.type === 'input' || node.type === 'select');
const names = () => tree!.root.findByType('tbody').findAllByType('tr').map(row => text(row));
const lastRead = () => new URL(fetchMock.mock.calls.filter(([, init]) => !init?.method).at(-1)![0], 'https://example.test');
async function settle() {
  await act(async () => {
    for (let count = -1; count !== requests.length;) {
      count = requests.length;
      await Promise.all(requests);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  scrollIntoView = vi.fn();
  vi.stubGlobal('document', { getElementById: vi.fn(() => ({ scrollIntoView })) });
  const test = convexTest(schema, modules);
  const ids = await test.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'admin@example.test' });
    await ctx.db.insert('portalMembers', { userId, role: 'admin', active: true, createdAt: date });
    const base = { kioskId: 'gate-1', timestamp: `${date}T10:00:00`, faceDetected: true, decision: 'near_miss',
      threshold: 0.3, bestScore: 0.8, reviewed: true, reviewedLabel: 'confirmed', createdAt: date };
    const targetId = await ctx.db.insert('recognitionAttempts', { ...base, candidateWorkerName: 'Exact reviewed target' });
    const otherId = await ctx.db.insert('recognitionAttempts', { ...base, kioskId: 'gate-2', decision: 'accepted', bestScore: 0.2,
      reviewed: false, reviewedLabel: undefined, candidateWorkerName: 'Unreviewed backlog' });
    await ctx.db.insert('recognitionAttempts', { ...base, timestamp: '2026-09-15T10:00:00', candidateWorkerName: 'Next day evidence' });
    return { userId, targetId, otherId };
  });
  targetId = ids.targetId;
  otherId = ids.otherId;
  const admin = test.withIdentity({ subject: ids.userId });
  vi.mocked(convex.query).mockImplementation((name, args = {}) => admin.query(name as FunctionReference<'query'>, args));
  vi.mocked(convex.mutation).mockImplementation((...call) => {
    const [name, args = {}] = call;
    return admin.mutation(name as FunctionReference<'mutation'>, args);
  });
  // The actual HTTP routes and Convex readers apply exact-target/filter semantics.
  requests = [];
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const request = new NextRequest(`https://example.test${url}`, { ...init, signal: init?.signal ?? undefined });
    const response = init?.method === 'PATCH' ? PATCH(request) : GET(request);
    requests.push(response);
    return response;
  });
  vi.stubGlobal('fetch', fetchMock);
  navigation.query = `date=${date}&attempt_id=${targetId}`;
  await act(async () => { tree = create(<RecognitionCalibrationLab />); });
  await settle();
});

afterEach(async () => {
  if (tree) await act(async () => tree!.unmount());
  tree = undefined;
  vi.unstubAllGlobals();
});

it('opens the exact source even when the URL filters would exclude it', async () => {
  navigation.query += '&review_status=unreviewed';
  await act(async () => tree!.update(<RecognitionCalibrationLab />));
  await settle();
  expect(names()).toEqual([expect.stringContaining('Exact reviewed target')]);
  expect(lastRead().searchParams.get('attempt_id')).toBe(targetId);
  expect(document.getElementById).toHaveBeenCalledWith(`recognition-attempt-${targetId}`);
  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
  expect(tree!.root.findByType('tbody').findByType('tr').props.className).toContain('ring-gold');
});

it.each([
  ['Decision', 'accepted'],
  ['Review', 'unreviewed'],
  ['Confidence', 'low'],
  ['Kiosk', 'gate-2'],
])('leaves the exact target when the supervisor changes %s', async (name, value) => {
  await act(async () => field(name).props.onChange({ target: { value } }));
  await settle();
  expect(names()).toEqual([expect.stringContaining('Unreviewed backlog')]);
  expect(lastRead().searchParams.has('attempt_id')).toBe(false);
});

it('loads the chosen day instead of an empty exact lookup on that day', async () => {
  await act(async () => field('Date').props.onChange({ target: { value: '2026-09-15' } }));
  await settle();
  expect(names()).toEqual([expect.stringContaining('Next day evidence')]);
  expect(lastRead().searchParams.has('attempt_id')).toBe(false);
});

it('shows the target restriction and lets the supervisor return to all matching attempts', async () => {
  expect(tree!.root.findAllByProps({ role: 'status' }).some(node => text(node).includes('Showing one linked recognition attempt'))).toBe(true);
  await act(async () => button('Show all attempts').props.onClick());
  await settle();
  expect(names()).toHaveLength(2);
  expect(lastRead().searchParams.get('limit')).toBe('150');
  expect(lastRead().searchParams.has('attempt_id')).toBe(false);
});

it('keeps the released target cleared through rerenders, refresh and review completion', async () => {
  await act(async () => field('Review').props.onChange({ target: { value: 'unreviewed' } }));
  await settle();
  await act(async () => tree!.update(<RecognitionCalibrationLab />));
  await act(async () => button('Refresh').props.onClick());
  await settle();
  await act(async () => button('Confirm').props.onClick());
  await settle();
  const write = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
  expect(JSON.parse(String(write![1]!.body)).id).toBe(otherId);
  expect(names()).toEqual([]);
  expect(fetchMock.mock.calls.filter(([, init]) => !init?.method).slice(1).every(([url]) => !new URL(url, 'https://example.test').searchParams.has('attempt_id'))).toBe(true);
});

it('keeps exact targeting through a review refresh until the supervisor leaves it', async () => {
  await act(async () => button('Ignore').props.onClick());
  await settle();
  expect(names()).toEqual([expect.stringContaining('Exact reviewed target')]);
  expect(names()[0]).toContain('Ignored');
  expect(lastRead().searchParams.get('attempt_id')).toBe(targetId);
});

it('applies the existing URL filters when Show all attempts releases the target', async () => {
  navigation.query += '&decision=accepted';
  await act(async () => tree!.update(<RecognitionCalibrationLab />));
  await settle();
  expect(names()).toEqual([expect.stringContaining('Exact reviewed target')]);
  await act(async () => button('Show all attempts').props.onClick());
  await settle();
  expect(names()).toEqual([expect.stringContaining('Unreviewed backlog')]);
  expect(field('Decision').props.value).toBe('accepted');
  expect(lastRead().searchParams.get('decision')).toBe('accepted');
});

it('retires exact-target review handlers while the broader selection is loading', async () => {
  const oldConfirm = button('Confirm').props.onClick;
  const realFetch = fetchMock.getMockImplementation()!;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  fetchMock.mockImplementationOnce((url: string, init?: RequestInit) => {
    const response = realFetch(url, init);
    const blocked = gate.then(() => response);
    requests.push(blocked);
    return blocked;
  });
  await act(async () => button('Show all attempts').props.onClick());
  await act(async () => oldConfirm());
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  release();
  await settle();
  expect(names()).toHaveLength(2);
});

it('restores exact targeting on URL navigation and when navigating back', async () => {
  const originalUrl = navigation.query;
  await act(async () => field('Review').props.onChange({ target: { value: 'unreviewed' } }));
  await settle();
  navigation.query = `date=${date}&attempt_id=${otherId}`;
  await act(async () => tree!.update(<RecognitionCalibrationLab />));
  await settle();
  expect(lastRead().searchParams.get('attempt_id')).toBe(otherId);
  expect(names()).toEqual([expect.stringContaining('Unreviewed backlog')]);
  navigation.query = originalUrl;
  await act(async () => tree!.update(<RecognitionCalibrationLab />));
  await settle();
  expect(lastRead().searchParams.get('attempt_id')).toBe(targetId);
  expect(names()).toEqual([expect.stringContaining('Exact reviewed target')]);
});

it('restores the linked date after manually browsing another day', async () => {
  await act(async () => field('Date').props.onChange({ target: { value: '2026-09-15' } }));
  await settle();
  expect(names()).toEqual([expect.stringContaining('Next day evidence')]);
  navigation.query = `date=${date}&attempt_id=${otherId}`;
  await act(async () => tree!.update(<RecognitionCalibrationLab />));
  await settle();
  expect(field('Date').props.value).toBe(date);
  expect(lastRead().searchParams.get('date')).toBe(date);
  expect(names()).toEqual([expect.stringContaining('Unreviewed backlog')]);
});

it('keeps a manual date and released target through same-URL refresh', async () => {
  await act(async () => field('Date').props.onChange({ target: { value: '2026-09-15' } }));
  await settle();
  await act(async () => tree!.update(<RecognitionCalibrationLab />));
  await act(async () => button('Refresh').props.onClick());
  await settle();
  expect(field('Date').props.value).toBe('2026-09-15');
  expect(lastRead().searchParams.has('attempt_id')).toBe(false);
  expect(names()).toEqual([expect.stringContaining('Next day evidence')]);
});

it('restores the linked date when navigating Back after another manual date selection', async () => {
  const originalUrl = navigation.query;
  navigation.query = `date=${date}&attempt_id=${otherId}`;
  await act(async () => tree!.update(<RecognitionCalibrationLab />));
  await settle();
  await act(async () => field('Date').props.onChange({ target: { value: '2026-09-15' } }));
  await settle();
  navigation.query = originalUrl;
  await act(async () => tree!.update(<RecognitionCalibrationLab />));
  await settle();
  expect(field('Date').props.value).toBe(date);
  expect(lastRead().searchParams.get('attempt_id')).toBe(targetId);
  expect(names()).toEqual([expect.stringContaining('Exact reviewed target')]);
});
