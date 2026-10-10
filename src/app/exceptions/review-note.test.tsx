/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { NextRequest } from 'next/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import schema from '../../../convex/schema';
import convex from '@/lib/convex';
import { hasValidPortalSession } from '@/lib/portal-auth';
import { PATCH } from '../api/shift-exceptions/route';
import ExceptionsPage from './page';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('date=2026-09-01&status=all') }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'admin' }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
vi.mock('@/lib/convex', () => ({ default: { mutation: vi.fn(), query: vi.fn() } }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: vi.fn() }));

const modules = import.meta.glob('../../../convex/**/*.ts');
const date = '2026-09-01';
const key = 'missing-worker';
const label = (node: any): string => typeof node === 'string' ? node : (node?.children || []).map(label).join('');
let tree: ReactTestRenderer;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hasValidPortalSession).mockResolvedValue(true);
});
afterEach(async () => {
  if (tree) await act(async () => tree.unmount());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Drives the real PATCH route and Convex review mutation; GET overlays the stored review onto one exception.
async function renderWithSavedNote(note: string) {
  vi.stubGlobal('document', { activeElement: null, createElement: () => ({ click: vi.fn() }), getElementById: () => null });
  vi.stubGlobal('HTMLElement', class {});
  const t = convexTest(schema, modules);
  const userId = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'supervisor@example.test' });
    await ctx.db.insert('portalMembers', { userId, role: 'admin', active: true, createdAt: date });
    await ctx.db.insert('exceptionReviews', { exceptionKey: key, date, type: 'missing_arrival', status: 'open', note, updatedAt: date });
    return userId;
  });
  const actor = t.withIdentity({ subject: userId });
  vi.mocked(convex.mutation).mockImplementation((...call) => {
    const [ref, args = {}] = call;
    return actor.mutation(ref, JSON.parse(JSON.stringify(args)));
  });
  const storedReview = () => t.run(ctx => ctx.db.query('exceptionReviews').withIndex('by_key', q => q.eq('exceptionKey', key)).first());
  const patches: any[] = [];
  const requests: Promise<unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const request = respond(url, init);
    requests.push(request);
    return request;
  }));
  async function respond(url: string, init?: RequestInit) {
    if (init?.method === 'PATCH') {
      patches.push(JSON.parse(String(init.body)));
      return PATCH(new NextRequest(`https://example.test${url}`, { method: 'PATCH', headers: init.headers, body: init.body }));
    }
    const review = await storedReview();
    return {
      ok: true,
      json: async () => ({ date, summary: {}, exceptions: [{
        key, date, worker_id: 'worker', worker_name: 'Worker', department: 'Operations',
        type: 'missing_arrival', severity: 'warning', status: review?.status ?? 'open', review_note: review?.note || null,
        description: 'No clock-in', links: {}, title: 'Missed scan',
        suggested_resolution: { can_apply: true, action: 'add_clock_in', corrected_time: '08:00',
          source_exception_key: key, reason: 'Verified arrival', label: 'Add clock-in', cta: 'Correct scan' },
      }] }),
    };
  }
  await act(async () => { tree = create(<ExceptionsPage />); });
  const button = (text: string) => tree.root.findAllByType('button').find((node) => label(node) === text)!;
  // Review saves are fire-and-forget; wait for the PATCH and the refresh it triggers.
  const click = async (text: string) => act(async () => {
    button(text).props.onClick();
    for (let seen = -1; seen !== requests.length;) {
      seen = requests.length;
      await Promise.allSettled(requests);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
  const textarea = () => tree.root.findByType('textarea');
  const type = async (value: string) => act(async () => textarea().props.onChange({ target: { value } }));
  const reload = async () => {
    await act(async () => tree.unmount());
    await act(async () => { tree = create(<ExceptionsPage />); });
  };
  const exportedCsv = async () => {
    let blob: Blob | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((value) => { blob = value as Blob; return 'blob:csv'; });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    await act(async () => button('Export CSV').props.onClick());
    return blob!.text();
  };
  return { button, click, textarea, type, reload, exportedCsv, storedReview, patches };
}

it('persists a cleared note, keeps the textarea empty after reload, and exports the cleared note', async () => {
  const page = await renderWithSavedNote('Old note');
  expect(page.textarea().props.value).toBe('Old note');
  expect(await page.exportedCsv()).toContain('Old note');

  await page.type('');
  await page.click('Reviewed');

  expect(page.patches).toEqual([expect.objectContaining({ status: 'reviewed', note: '' })]);
  const stored = await page.storedReview();
  expect(stored).toMatchObject({ status: 'reviewed' });
  expect(stored).not.toHaveProperty('note');
  expect(page.textarea().props.value).toBe('');

  await page.reload();
  expect(page.textarea().props.value).toBe('');
  const csv = await page.exportedCsv();
  expect(csv).not.toContain('Old note');
  expect(csv.split('\n')[1].endsWith(',')).toBe(true);
});

it('treats a whitespace-only note as a clear and shows the saved empty note', async () => {
  const page = await renderWithSavedNote('Old note');
  await page.type('   ');
  await page.click('Reviewed');
  expect(await page.storedReview()).not.toHaveProperty('note');
  expect(page.textarea().props.value).toBe('');
});

it('keeps an unchanged note', async () => {
  const page = await renderWithSavedNote('Old note');
  await page.click('Resolved');
  expect(page.patches).toEqual([expect.objectContaining({ status: 'resolved', note: 'Old note' })]);
  expect(await page.storedReview()).toMatchObject({ status: 'resolved', note: 'Old note' });
  expect(page.textarea().props.value).toBe('Old note');
});

it('saves an edited note and syncs the textarea with the trimmed saved value', async () => {
  const page = await renderWithSavedNote('Old note');
  await page.type('  New note  ');
  await page.click('Reviewed');
  expect(await page.storedReview()).toMatchObject({ status: 'reviewed', note: 'New note' });
  expect(page.textarea().props.value).toBe('New note');
  await page.reload();
  expect(page.textarea().props.value).toBe('New note');
  expect(await page.exportedCsv()).toContain('New note');
});

it('does not prefill the correction reason with a note the supervisor cleared', async () => {
  const page = await renderWithSavedNote('Old note');
  await page.type('');
  await act(async () => page.button('Correct scan').props.onClick());
  const reason = tree.root.findAllByType('textarea').find((node) => node.props.value === 'Verified arrival');
  expect(reason).toBeDefined();
  expect(tree.root.findAllByType('textarea').some((node) => node.props.value === 'Old note')).toBe(false);
});
