/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { NextRequest } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { api } from '../../../../convex/_generated/api';
import schema from '../../../../convex/schema';
import convex from '@/lib/convex';
import { GET } from './route';

vi.mock('@/lib/convex', () => ({ default: { query: vi.fn() } }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: vi.fn(async () => true) }));
const modules = import.meta.glob('../../../../convex/**/*.ts');
let test: ReturnType<typeof convexTest>;
const base = { kioskId: 'entry', timestamp: '2026-09-14T10:00:00', faceDetected: true,
  decision: 'accepted', threshold: 0.3, bestScore: 0.8, reviewed: true,
  reviewedLabel: 'confirmed', createdAt: '2026-09-14T10:00:00' };
beforeEach(async () => {
  test = convexTest(schema, modules);
  const user = await test.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'viewer@example.test' });
    await ctx.db.insert('portalMembers', { userId, role: 'viewer', active: true, createdAt: base.createdAt });
    for (let i = 0; i < 150; i++) await ctx.db.insert('recognitionAttempts', base);
    return userId;
  });
  const viewer = test.withIdentity({ subject: user });
  // This route uses a generated reference, not the HTTP client's future references.
  vi.mocked(convex.query).mockImplementation((name, args = {}) =>
    viewer.query(name as typeof api.recognitionAttempts.listByDate, args));
});
async function get(params: string) {
  const search = new URLSearchParams(params);
  if (!search.has('limit')) search.set('limit', '150');
  search.set('date', '2026-09-14');
  const response = await GET(new NextRequest(`https://example.test/api/recognition-attempts?${search}`));
  expect(response.status).toBe(200);
  return response.json();
}
it.each([
  ['decision=near_miss', { decision: 'near_miss' }],
  ['decision=rejected', { decision: 'rejected_liveness' }],
  ['confidence_band=low', { bestScore: 0.2 }],
  ['confidence_band=medium', { bestScore: 0.3 }],
  ['review_status=corrected', { reviewedLabel: 'corrected' }],
  ['review_status=ignored', { reviewedLabel: 'ignored' }],
  ['decision=near_miss&confidence_band=low&review_status=corrected', { decision: 'near_miss', bestScore: 0.2, reviewedLabel: 'corrected' }],
])('finds older matches beyond 150 nonmatches: %s', async (params, changes) => {
  const id = await test.run(ctx => ctx.db.insert('recognitionAttempts', { ...base, timestamp: '2026-09-14T08:00:00', ...changes }));
  const response = await get(params);
  expect(response.attempts.map((row: { id: string }) => row.id)).toEqual([id]);
  expect(response.summary.total).toBe(1);
});
it('keeps accepted aliases, missing review labels, score boundaries and full-selection summaries', async () => {
  const id = await test.run(ctx => ctx.db.insert('recognitionAttempts', { ...base, timestamp: '2026-09-14T11:00:00', decision: 'accepted_manual', bestScore: 0.45, reviewedLabel: undefined }));
  const response = await get('decision=accepted&confidence_band=high&review_status=confirmed&limit=1');
  expect(response.attempts).toHaveLength(1);
  expect(response.attempts[0].id).toBe(id);
  expect(response.summary.accepted).toBe(151);
  expect(response.truncated).toBe(true);
});
it('retrieves exact older attempts despite incompatible list filters', async () => {
  const id = await test.run(ctx => ctx.db.insert('recognitionAttempts', { ...base, timestamp: '2026-09-14T08:00:00' }));
  const response = await get(`attempt_id=${id}&decision=near_miss&confidence_band=low&review_status=ignored`);
  expect(response.attempts.map((row: { id: string }) => row.id)).toEqual([id]);
  expect(response.summary.total).toBe(1);
});
it.each(['confirmed', 'corrected', 'ignored'])('excludes %s near misses from review backlog', async reviewedLabel => {
  await test.run(async ctx => {
    await ctx.db.insert('recognitionAttempts', { ...base, decision: 'near_miss', reviewedLabel });
    await ctx.db.insert('recognitionAttempts', { ...base, decision: 'near_miss', reviewed: false });
  });
  const response = await get('decision=near_miss');
  expect(response.attempts).toHaveLength(2);
  expect(response.summary.review_backlog).toBe(1);
});

it('counts the older unreviewed attempt across a capped display, including refresh', async () => {
  const id = await test.run(ctx => ctx.db.insert('recognitionAttempts', { ...base, timestamp: '2026-09-14T08:00:00', reviewed: false, reviewedLabel: undefined }));
  for (let refresh = 0; refresh < 2; refresh++) {
    const response = await get('');
    expect(response.attempts).toHaveLength(150);
    expect(response.attempts.some((row: { id: string }) => row.id === id)).toBe(false);
    expect(response.summary).toMatchObject({ total: 151, accepted: 151, review_backlog: 1 });
    expect(response.truncated).toBe(true);
    expect(response.summary_limited).toBe(false);
  }
  const unreviewed = await get('review_status=unreviewed');
  expect(unreviewed.attempts.map((row: { id: string }) => row.id)).toEqual([id]);
  expect(unreviewed.summary.review_backlog).toBe(1);
  expect(unreviewed.truncated).toBe(false);
});

it('does not report truncation when the full selection exactly fills the display', async () => {
  const response = await get('');
  expect(response.summary.total).toBe(150);
  expect(response.truncated).toBe(false);
  expect(response.summary_limited).toBe(false);
});

it('reports lower bounds and no median when the indexed read is capped', async () => {
  const id = await test.run(async ctx => {
    for (let i = 0; i < 850; i++) await ctx.db.insert('recognitionAttempts', base);
    return ctx.db.insert('recognitionAttempts', { ...base, timestamp: '2026-09-14T08:00:00', reviewed: false, reviewedLabel: undefined });
  });
  const response = await get('limit=1000');
  expect(response.attempts).toHaveLength(1000);
  expect(response.summary).toMatchObject({ total: 1000, accepted: 1000, review_backlog: 0, median_score: null });
  expect(response.truncated).toBe(true);
  expect(response.summary_limited).toBe(true);
  const first = await get('review_status=unreviewed');
  expect(first.summary_limited).toBe(true);
  expect(first.next_scan_cursor).toBeTruthy();
  const unreviewed = await get(`review_status=unreviewed&scan_cursor=${encodeURIComponent(first.next_scan_cursor)}`);
  expect(unreviewed.attempts.map((row: { id: string }) => row.id)).toEqual([id]);
  // Prior windows are outside this count, so it remains a full-day lower bound.
  expect(unreviewed.summary_limited).toBe(true);
  expect(unreviewed.next_scan_cursor).toBeNull();
});

it('reports an incomplete selection even when neighboring-day rows consume the read bound', async () => {
  await test.run(async ctx => {
    for (let i = 0; i < 1001; i++) await ctx.db.insert('recognitionAttempts', { ...base, timestamp: '2026-09-15T10:00:00' });
  });
  const response = await get('');
  expect(response.attempts).toHaveLength(0);
  expect(response.summary.total).toBe(0);
  expect(response.truncated).toBe(true);
  expect(response.summary_limited).toBe(true);
});

it('warns about capped legacy array responses during a staggered rollout', async () => {
  vi.mocked(convex.query).mockResolvedValueOnce(Array.from({ length: 150 }, (_, i) => ({ ...base, id: `legacy-${i}` })));
  const response = await get('');
  expect(response.summary).toMatchObject({ total: 150, review_backlog: 0, median_score: null });
  expect(response.truncated).toBe(true);
  expect(response.summary_limited).toBe(true);
});


it.each(['', 'decision=accepted&confidence_band=high&kiosk_id=entry'])('includes invalid legacy review labels in the unresolved selection: %s', async filters => {
  const id = await test.run(ctx => ctx.db.insert('recognitionAttempts', { ...base, reviewedLabel: 'legacy-pending' }));
  const response = await get(`review_status=unreviewed&${filters}`);
  expect(response.attempts.map((row: { id: string }) => row.id)).toEqual([id]);
  expect(response.summary.review_backlog).toBe(1);
  expect(response.summary_limited).toBe(false);
});

it('reaches selected-day evidence after an empty window of neighboring-day scans', async () => {
  const id = await test.run(async ctx => {
    for (let i = 0; i < 1001; i++) await ctx.db.insert('recognitionAttempts', { ...base, timestamp: '2026-09-15T10:00:00', reviewed: false });
    return ctx.db.insert('recognitionAttempts', { ...base, timestamp: '2026-09-14T08:00:00', reviewed: false });
  });
  const first = await get('review_status=unreviewed&decision=accepted&confidence_band=high&kiosk_id=entry');
  expect(first.attempts).toHaveLength(0);
  expect(first.summary_limited).toBe(true);
  expect(first.next_scan_cursor).toBeTruthy();
  const next = await get(`review_status=unreviewed&decision=accepted&confidence_band=high&kiosk_id=entry&scan_cursor=${encodeURIComponent(first.next_scan_cursor)}&limit=1000`);
  expect(next.attempts.map((row: { id: string }) => row.id)).toEqual([id]);
  expect(next.next_scan_cursor).toBeNull();
});

it('visits every unresolved record across windows with equal and mixed-format timestamps', async () => {
  const ids = await test.run(async ctx => {
    const inserted = [];
    for (let i = 0; i < 1100; i++) inserted.push(await ctx.db.insert('recognitionAttempts', { ...base, reviewed: false,
      timestamp: ['2026-09-14T10:00:00', '2026-09-14T16:00:00Z', '2026-09-14T11:00:00-05:00'][i % 3] }));
    return inserted;
  });
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let window = 0; window < 4; window++) {
    const response = await get(`review_status=unreviewed&limit=1000${cursor ? `&scan_cursor=${encodeURIComponent(cursor)}` : ''}`);
    seen.push(...response.attempts.map((row: { id: string }) => row.id));
    cursor = response.next_scan_cursor;
    if (!cursor) break;
  }
  expect(cursor).toBeNull();
  expect(seen).toHaveLength(ids.length);
  expect(new Set(seen)).toEqual(new Set(ids));
});


it('marks only uncertain categories when filters prove other counts exact', async () => {
  await test.run(async ctx => {
    for (let i = 0; i < 1001; i++) await ctx.db.insert('recognitionAttempts', base);
  });
  const response = await get('decision=accepted&review_status=confirmed');
  expect(response.summary_limited).toBe(true);
  expect(response.summary_limited_fields.sort()).toEqual(['accepted', 'low_margin_accepted', 'total'].sort());
  expect(response.summary).toMatchObject({ rejected: 0, unknown: 0, near_miss: 0, review_backlog: 0 });
});

it('keeps an exactly complete 1000-record selection exact', async () => {
  await test.run(async ctx => {
    for (let i = 0; i < 850; i++) await ctx.db.insert('recognitionAttempts', base);
  });
  const response = await get('limit=1000');
  expect(response.summary.total).toBe(1000);
  expect(response.summary_limited).toBe(false);
  expect(response.summary_limited_fields).toEqual([]);
  expect(response.next_scan_cursor).toBeNull();
});


it('keeps large review notes within a byte-bounded scan and continues without losing evidence', async () => {
  const ids = await test.run(async ctx => {
    const inserted = [];
    for (let i = 0; i < 900; i++) inserted.push(await ctx.db.insert('recognitionAttempts', { ...base, reviewed: false, reviewedNote: 'x'.repeat(12000) }));
    return inserted;
  });
  const first = await get('review_status=unreviewed&limit=1000');
  expect(first.attempts.length).toBeGreaterThan(0);
  expect(first.attempts.length).toBeLessThan(900);
  expect(first.summary_limited).toBe(true);
  const seen = first.attempts.map((row: { id: string }) => row.id);
  let cursor = first.next_scan_cursor;
  for (let window = 0; window < 5 && cursor; window++) {
    const response = await get(`review_status=unreviewed&limit=1000&scan_cursor=${encodeURIComponent(cursor)}`);
    seen.push(...response.attempts.map((row: { id: string }) => row.id));
    cursor = response.next_scan_cursor;
  }
  expect(cursor).toBeNull();
  expect(seen).toHaveLength(ids.length);
  expect(new Set(seen)).toEqual(new Set(ids));
});
