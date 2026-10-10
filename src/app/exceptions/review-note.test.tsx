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
  // Test hooks: hold the next PATCH until released, or run something right after it saves.
  const hooks: { patchGate?: Promise<void>; afterPatch?: () => Promise<unknown> } = {};
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const request = respond(url, init);
    requests.push(request);
    return request;
  }));
  async function respond(url: string, init?: RequestInit) {
    if (init?.method === 'PATCH') {
      patches.push(JSON.parse(String(init.body)));
      const { patchGate, afterPatch } = hooks;
      delete hooks.patchGate;
      delete hooks.afterPatch;
      await patchGate;
      const res = await PATCH(new NextRequest(`https://example.test${url}`, { method: 'PATCH', headers: init.headers, body: init.body }));
      await afterPatch?.();
      return res;
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
  const drain = async () => {
    for (let seen = -1; seen !== requests.length;) {
      seen = requests.length;
      await Promise.allSettled(requests);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  const click = async (text: string) => act(async () => {
    button(text).props.onClick();
    await drain();
  });
  const settle = async () => act(drain);
  const setStoredNote = (value: string) => t.run(async ctx => {
    const review = await ctx.db.query('exceptionReviews').withIndex('by_key', q => q.eq('exceptionKey', key)).first();
    await ctx.db.patch(review!._id, { note: value });
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
  return { button, click, settle, textarea, type, reload, exportedCsv, storedReview, setStoredNote, patches, hooks };
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

it('keeps text typed while a save is in flight and sends it on the next save', async () => {
  const page = await renderWithSavedNote('Old note');
  let release!: () => void;
  page.hooks.patchGate = new Promise<void>((resolve) => { release = resolve; });
  await page.type('');
  await act(async () => page.button('Reviewed').props.onClick());
  await page.type('Typed during save');
  release();
  await page.settle();
  expect(await page.storedReview()).toMatchObject({ status: 'reviewed' });
  expect(await page.storedReview()).not.toHaveProperty('note');
  expect(page.textarea().props.value).toBe('Typed during save');
  await page.click('Resolved');
  expect(page.patches.at(-1)).toMatchObject({ status: 'resolved', note: 'Typed during save' });
  expect(await page.storedReview()).toMatchObject({ status: 'resolved', note: 'Typed during save' });
});

it('shows the refreshed server note after a save instead of pinning the sent note', async () => {
  const page = await renderWithSavedNote('Old note');
  // Another supervisor saves a note after this save lands but before the page refreshes.
  page.hooks.afterPatch = () => page.setStoredNote('Other supervisor note');
  await page.click('Reviewed');
  expect(page.textarea().props.value).toBe('Other supervisor note');
  await page.click('Resolved');
  expect(page.patches.at(-1)).toMatchObject({ status: 'resolved', note: 'Other supervisor note' });
});
