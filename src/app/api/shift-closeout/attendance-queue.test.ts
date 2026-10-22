/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../../convex/schema';
import { api } from '../../../../convex/_generated/api';
import convex from '@/lib/convex';
import { hasValidPortalSession } from '@/lib/portal-auth';
import { GET, PATCH } from './route';
import { GET as briefing } from '../shift-briefing/route';

vi.mock('@/lib/convex', () => ({ default: { mutation: vi.fn(), query: vi.fn() } }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: vi.fn() }));
const modules = import.meta.glob('../../../../convex/**/*.ts');
const date = '2026-10-18';
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hasValidPortalSession).mockResolvedValue(true);
});

async function setup() {
  const t = convexTest(schema, modules);
  const userId = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'closeout@example.test' });
    await ctx.db.insert('portalMembers', { userId, role: 'admin', active: true, createdAt: date });
    const now = new Date().toISOString();
    await ctx.db.insert('kiosks', { name: 'Queue gate', type: 'entry', location: 'Gate', active: true, lastSync: now,
      health: { cameraOk: true, modelOk: true, queuedLogs: 3, reportedAt: now },
      attendanceQueue: { lastValidCount: 3, observedAt: now, latest: 'reported' } });
    return userId;
  });
  const actor = t.withIdentity({ subject: userId });
  // Match Convex HTTP serialization: undefined fields disappear on the wire.
  vi.mocked(convex.mutation).mockImplementation((...call) => {
    const [ref, args = {}] = call;
    return actor.mutation(ref, JSON.parse(JSON.stringify(args)));
  });
  vi.mocked(convex.query).mockImplementation((...call) => {
    const [ref, args = {}] = call;
    return actor.query(ref, JSON.parse(JSON.stringify(args)));
  });
  let request = 0;
  const patch = (fields: Record<string, unknown>) => PATCH(new NextRequest('https://example.test/api/shift-closeout', {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ date, request_id: `queue-route-${++request}`, expected_revision: null, ...fields }),
  }));
  return { t, patch };
}

it('rejects API completion with queued attendance until acknowledged with a reason', async () => {
  const { t, patch } = await setup();
  const payload = await (await GET(new NextRequest(`https://example.test/api/shift-closeout?date=${date}`))).json();
  expect(payload).toMatchObject({ can_complete: false, attendance_queue: { affected_kiosks: 1, pending_records: 3 } });
  const unacknowledged = await patch({ action: 'complete', notes: 'Signed without review', blocker_evidence: payload.blocker_evidence });
  expect(unacknowledged.status).toBe(409);
  const blank = await patch({ action: 'complete', notes: ' ', acknowledged_blockers: true, blocker_evidence: payload.blocker_evidence });
  expect(blank.status).toBe(409);
  expect(await t.run(ctx => ctx.db.query('shiftCloseouts').collect())).toEqual([]);
  const signed = await patch({ action: 'complete', notes: 'Gate queue reviewed', acknowledged_blockers: true, blocker_evidence: payload.blocker_evidence });
  expect(signed.status).toBe(200);
  const [record] = await t.run(ctx => ctx.db.query('shiftCloseouts').collect());
  expect(record).toMatchObject({ status: 'completed', attendanceQueueEvidence: { pendingRecords: 3, affectedKiosks: 1 } });
});

it('denies portal sessions without a write role', async () => {
  const { t, patch } = await setup();
  vi.mocked(hasValidPortalSession).mockResolvedValue(false);
  expect((await patch({ action: 'complete', notes: 'Viewer', acknowledged_blockers: true })).status).toBe(401);
  expect(await t.run(ctx => ctx.db.query('shiftCloseouts').collect())).toEqual([]);
});

it('reports queue evidence as unavailable, not clear, while functions are undeployed', async () => {
  vi.mocked(convex.query).mockRejectedValue(new Error('Could not find public function for shiftCloseouts:get'));
  const closeout = await (await GET(new NextRequest(`https://example.test/api/shift-closeout?date=${date}`))).json();
  expect(closeout).toMatchObject({ backend_unavailable: true, can_complete: false, attendance_queue: null });
  vi.mocked(convex.query).mockRejectedValue(new Error('Could not find public function for shiftBriefing:summary'));
  const brief = await (await briefing(new NextRequest(`https://example.test/api/shift-briefing?date=${date}`))).json();
  expect(brief).toMatchObject({ backend_unavailable: true, kiosks: { attendance_queue: null } });
});

it('does not hide a backend failure as an empty queue', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(convex.query).mockRejectedValue(new Error('Database unavailable'));
  const response = await GET(new NextRequest(`https://example.test/api/shift-closeout?date=${date}`));
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: 'Failed to fetch shift closeout' });
});

describe('portal ahead of an older backend', () => {
  const complete = () => PATCH(new NextRequest('https://example.test/api/shift-closeout', {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ date, request_id: 'mixed-version', expected_revision: null, action: 'complete', notes: 'No review' }),
  }));

  it.each([
    ['omits queue evidence', async () => ({ date, closeout: null, can_complete: true })],
    ['returns a malformed queue', async () => ({ date, closeout: null, can_complete: true, attendance_queue: { affected_kiosks: '0' } })],
    ['cannot be read', async () => { throw new Error('Could not find public function for shiftCloseouts:get'); }],
  ])('refuses a new signoff when the backend %s', async (_label, read) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(convex.query).mockImplementation(read as never);
    const response = await complete();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'CLOSEOUT_QUEUE_EVIDENCE_UNAVAILABLE' });
    expect(convex.mutation).not.toHaveBeenCalled();
  });

  it('still recovers the receipt of an already completed record', async () => {
    vi.mocked(convex.query).mockResolvedValue({ date, closeout: { status: 'completed' } });
    vi.mocked(convex.mutation).mockResolvedValue({ id: 'closeout', status: 'completed', revision: 1, requestId: 'mixed-version', actorUserId: 'user' });
    expect((await complete()).status).toBe(200);
    expect(convex.mutation).toHaveBeenCalledOnce();
  });

  it('does not gate saving notes', async () => {
    vi.mocked(convex.query).mockResolvedValue({ date, closeout: null });
    vi.mocked(convex.mutation).mockResolvedValue({ id: 'closeout', status: 'open', revision: 1, requestId: 'mixed-save', actorUserId: 'user' });
    const response = await PATCH(new NextRequest('https://example.test/api/shift-closeout', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date, request_id: 'mixed-save', expected_revision: null, action: 'save', notes: 'Draft' }),
    }));
    expect(response.status).toBe(200);
    expect(convex.query).not.toHaveBeenCalled();
  });
});

it('recovers a lost completion receipt after a later reopen when reads lack queue evidence', async () => {
  const t = convexTest(schema, modules);
  const userId = await t.run(async ctx => {
    const id = await ctx.db.insert('users', { email: 'closeout-replay@example.test' });
    await ctx.db.insert('portalMembers', { userId: id, role: 'admin', active: true, createdAt: date });
    return id;
  });
  const actor = t.withIdentity({ subject: userId });
  vi.mocked(convex.mutation).mockImplementation((...call) => {
    const [ref, args = {}] = call;
    return actor.mutation(ref, JSON.parse(JSON.stringify(args)));
  });
  // Simulate a backend that predates queue evidence: reads omit the field.
  vi.mocked(convex.query).mockImplementation(async (...call) => {
    const [ref, args = {}] = call;
    const { attendance_queue: _omitted, ...rest } = await actor.query(ref, JSON.parse(JSON.stringify(args)));
    return rest;
  });
  const send = (fields: Record<string, unknown>) => PATCH(new NextRequest('https://example.test/api/shift-closeout', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ date, ...fields }),
  }));
  // The original completion committed but its response was lost.
  const original = await actor.mutation(api.shiftCloseouts.save, { date, action: 'complete', requestId: 'lost-response', expectedRevision: null, notes: 'Signed' });
  await actor.mutation(api.shiftCloseouts.save, { date, action: 'reopen', requestId: 'later-reopen', expectedRevision: original.revision });
  const replay = await send({ action: 'complete', request_id: 'lost-response', expected_revision: null, notes: 'Signed' });
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(original);
  // A fresh signature at the current revision is still refused.
  const fresh = await send({ action: 'complete', request_id: 'fresh-signoff', expected_revision: original.revision + 1, notes: 'Signed again' });
  expect(fresh.status).toBe(503);
  // A stale new request can only fail the revision check.
  const stale = await send({ action: 'complete', request_id: 'stale-signoff', expected_revision: original.revision, notes: 'Stale' });
  expect(stale.status).toBe(409);
  expect(await t.run(ctx => ctx.db.query('shiftCloseoutHistory').collect())).toHaveLength(2);
  expect((await t.run(ctx => ctx.db.query('shiftCloseouts').collect()))[0].status).toBe('reopened');
});
