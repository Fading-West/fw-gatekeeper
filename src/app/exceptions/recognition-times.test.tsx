/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { NextRequest } from 'next/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../../convex/_generated/api';
import schema from '../../../convex/schema';
import convex from '@/lib/convex';
import RecognitionCalibrationLab from '@/components/RecognitionCalibrationLab';
import { GET } from '../api/recognition-attempts/route';
import Dashboard from '../page';
import ExceptionsPage from './page';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'viewer' }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
vi.mock('@/lib/convex', () => ({ default: { query: vi.fn() } }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: vi.fn(async () => true) }));

const modules = import.meta.glob('../../../convex/**/*.ts');
const label = (node: any): string => typeof node === 'string' ? node : (node?.children || []).map(label).join('');
const trees: ReactTestRenderer[] = [];
afterEach(async () => {
  await act(async () => { for (const tree of trees.splice(0)) tree.unmount(); });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it.each([
  ['2026-10-09', ['2026-10-09T12:05:00+00:00'], ['2026-10-09T07:05:00']],
  ['2026-03-08', ['2026-03-08T07:59:00Z', '2026-03-08T08:01:00Z'], ['2026-03-08T01:59:00', '2026-03-08T03:01:00']],
  ['2026-11-01', ['2026-11-01T06:45:00Z', '2026-11-01T07:15:00Z'], ['2026-11-01T01:45:00', '2026-11-01T01:15:00']],
] as Array<[string, string[], string[]]>)('renders and exports factory times through both portal consumers on %s', async (date, timestamps, localTimes) => {
  // A supervisor viewing from outside Chicago must still see factory wall time.
  vi.stubEnv('TZ', 'Asia/Tokyo');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${date}T12:00:00Z`));
  const t = convexTest(schema, modules);
  const userId = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'viewer@example.test' });
    await ctx.db.insert('portalMembers', { userId, role: 'viewer', active: true, createdAt: date });
    for (const timestamp of timestamps) await ctx.db.insert('recognitionAttempts', {
      timestamp, kioskId: 'entry', faceDetected: true, decision: 'near_miss', threshold: 0.3, reviewed: false, createdAt: date,
    });
    return userId;
  });
  const viewer = t.withIdentity({ subject: userId });
  vi.mocked(convex.query).mockImplementation((name, args = {}) => viewer.query(name, args));
  const recognitionResponse = await GET(new NextRequest(`https://example.test/api/recognition-attempts?date=${date}`));
  expect(recognitionResponse.status).toBe(200);
  const recognition = await recognitionResponse.json();
  expect(recognition.attempts.map((row: any) => row.timestamp)).toEqual([...localTimes].reverse());
  expect(recognition.attempts.every((row: any) => row.timestamp_utc?.endsWith('Z'))).toBe(true);
  const exceptions = await viewer.query(api.shiftExceptions.summary, { date });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.startsWith('/api/shift-exceptions') ? exceptions : recognition })));
  let exported: Blob | undefined;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { exported = blob as Blob; return 'blob:csv'; });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.stubGlobal('document', { createElement: () => ({ click: vi.fn() }) });
  await act(async () => { trees.push(create(<ExceptionsPage />), create(<RecognitionCalibrationLab />)); });
  for (const localTime of localTimes) {
    const expected = new Date(`${localTime}Z`).toLocaleString([], { timeZone: 'UTC', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    for (const tree of trees) expect(label(tree.toJSON())).toContain(expected);
  }
  await act(async () => trees[0].root.findAllByType('button').find(node => label(node) === 'Export CSV')!.props.onClick());
  const rows = (await exported!.text()).split('\n').slice(1);
  expect(rows.map(row => row.split(',').slice(6, 8))).toEqual(localTimes.map(time => [time, time]));

  // The dashboard uses elapsed time, so it must consume the retained UTC instant.
  vi.setSystemTime(new Date(Date.parse(timestamps.at(-1)!) + 5 * 60_000));
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: url.startsWith('/api/shift-exceptions'),
    status: 503,
    json: async () => url.startsWith('/api/shift-exceptions') ? exceptions : { error: 'Unavailable' },
  })));
  await act(async () => { trees.push(create(<Dashboard />)); });
  const cards = trees.at(-1)!.root.findAllByType('article').filter(node => label(node).includes('needs recognition review'));
  expect(label(cards.at(-1))).toContain('5m ago');
});
