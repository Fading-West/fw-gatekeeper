/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import { api, internal } from './_generated/api';
import schema from './schema';
import { buildSignedAttendanceEvidence, compareSignedAttendanceEvidence, isSignedAttendanceEvidence, MAX_ATTENDANCE_EVIDENCE_ROWS, MAX_CANONICAL_BYTES } from './signedAttendanceEvidence';
import type { Doc } from './_generated/dataModel';

const modules = import.meta.glob('./**/*.ts');
const date = '2026-09-02';
const raw = { _id: 'a', _creationTime: 1, workerId: 'w', eventType: 'clock_in', timestamp: '2026-09-02T05:30:00.123456Z', synced: true } as Doc<'attendance'>;
const correction = { _id: 'c', _creationTime: 2, date, workerId: 'w', action: 'add_clock_out', eventType: 'clock_out', correctedTimestamp: '2026-09-02T15:00:00', reason: 'Audit', actorUserId: 'u', createdAt: 'now', updatedAt: 'now' } as Doc<'attendanceCorrections'>;
const reversal = { _id: 'r', _creationTime: 3, date, correctionId: 'c', workerId: 'w', reason: 'Undo', actorUserId: 'u', createdAt: 'later', requestId: 'request' } as Doc<'attendanceCorrectionReversals'>;
const digest = (r = raw, c = correction, v = reversal) => buildSignedAttendanceEvidence(date, { raw: [r], corrections: [c], reversals: [v] }).digest;

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'synthetic@example.invalid' });
    await ctx.db.insert('portalMembers', { userId, role: 'enrollment', active: true, createdAt: '2026-09-02T00:00:00Z' });
    const viewerId = await ctx.db.insert('users', { email: 'viewer@example.invalid' });
    await ctx.db.insert('portalMembers', { userId: viewerId, role: 'viewer', active: true, createdAt: '2026-09-02T00:00:00Z' });
    const workerId = await ctx.db.insert('workers', { name: 'Synthetic', department: 'Test', active: false, enrolledAt: '2026-01-01T00:00:00Z' });
    return { userId, viewerId, workerId };
  });
  const actor = t.withIdentity({ subject: ids.userId });
  const complete = async (selected = date) => {
    const p = await actor.query(api.shiftCloseouts.get, { date: selected });
    return actor.mutation(api.shiftCloseouts.save, { date: selected, action: 'complete', notes: 'Synthetic evidence reviewed', acknowledgedBlockers: true, blockerEvidence: p.blocker_evidence });
  };
  return { t, actor, complete, ...ids };
}

describe('versioned signed attendance evidence', () => {
  it('is canonical across query order and excludes display, sync, retry and database metadata', () => {
    const input = { raw: [raw, { ...raw, _id: 'b' } as Doc<'attendance'>], corrections: [correction], reversals: [reversal] };
    expect(buildSignedAttendanceEvidence(date, input)).toEqual(buildSignedAttendanceEvidence(date, { ...input, raw: [...input.raw].reverse() }));
    expect(digest({ ...raw, _creationTime: 500, synced: false, workerName: 'Renamed', idempotencyKey: 'retry' }, { ...correction, updatedAt: 'changed', requestId: 'retry', relatedExceptionKey: 'label', sourceFingerprint: 'new' }, { ...reversal, requestId: 'retry', _creationTime: 99 })).toBe(digest());
    expect(digest()).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each(['_id','workerId','eventType','timestamp','kioskId','confidence','livenessConfirmed','note'] as const)('detects raw %s changes without changing counts', field => {
    const values = { _id: 'new', workerId: 'other', eventType: 'clock_out', timestamp: '2026-09-02T00:30:00.123456-05:00', kioskId: 'gate', confidence: 0.5, livenessConfirmed: false, note: 'audit' };
    expect(digest({ ...raw, [field]: values[field] })).not.toBe(digest());
  });
  it.each(['_id','date','workerId','action','eventType','correctedTimestamp','originalAttendanceId','reason','supervisorName','actorUserId','createdAt'] as const)('detects correction %s changes', field => {
    expect(digest(raw, { ...correction, [field]: `changed-${field}` } as Doc<'attendanceCorrections'>)).not.toBe(digest());
  });
  it.each(['_id','correctionId','date','workerId','reason','actorUserId','createdAt'] as const)('detects reversal %s changes', field => {
    expect(digest(raw, correction, { ...reversal, [field]: `changed-${field}` } as Doc<'attendanceCorrectionReversals'>)).not.toBe(digest());
  });
  it('normalizes missing optionals and rejects malformed or unsupported baselines', () => {
    const signed = buildSignedAttendanceEvidence(date, { raw: [], corrections: [], reversals: [] });
    expect(isSignedAttendanceEvidence(signed)).toBe(true);
    for (const bad of [null, {}, { ...signed, version: 2 }, { ...signed, digest: 'bad' }, { ...signed, raw_punches: -1 }, { ...signed, corrections: 1.5 }, { ...signed, reversals: Number.MAX_SAFE_INTEGER + 1 }]) expect(isSignedAttendanceEvidence(bad)).toBe(false);
    // Capture caps are not validity rules: a baseline signed under another cap stays comparable.
    expect(isSignedAttendanceEvidence({ ...signed, raw_punches: MAX_ATTENDANCE_EVIDENCE_ROWS + 1 })).toBe(true);
    expect(digest({ ...raw, note: undefined })).toBe(digest());
  });

  it('captures empty days, detects late uploads, keeps retries/history immutable, and re-signs explicitly', async () => {
    const { t, actor, complete, workerId } = await setup();
    const signed = await complete();
    const before = await t.run(ctx => ctx.db.get(signed.id));
    expect(before?.signedAttendanceEvidence).toMatchObject({ version: 1, raw_punches: 0, corrections: 0, reversals: 0 });
    expect((await actor.query(api.shiftCloseouts.get, { date })).attendance_comparison.status).toBe('unchanged');
    const punch = { workerId, eventType: 'clock_in', timestamp: '2026-09-02T05:30:00.123456Z', kioskId: 'synthetic', idempotencyKey: 'late' };
    await t.mutation(internal.attendance.bulkCreateFromHttp, { events: [punch] });
    await t.mutation(internal.attendance.bulkCreateFromHttp, { events: [punch] });
    const afterUpload = await actor.query(api.shiftCloseouts.get, { date });
    expect(afterUpload.attendance_comparison).toMatchObject({ status: 'changed', signed: { raw_punches: 0 }, current: { raw_punches: 1 }, activity_log_href: `/log?date=${date}` });
    await actor.mutation(api.shiftCloseouts.save, { date, action: 'complete', notes: 'Retry must not re-sign' });
    expect(await t.run(ctx => ctx.db.get(signed.id))).toEqual(before);
    expect(await t.run(ctx => ctx.db.query('shiftCloseoutHistory').collect())).toHaveLength(1);
    await actor.mutation(api.shiftCloseouts.save, { date, action: 'reopen' });
    expect((await actor.query(api.shiftCloseouts.get, { date })).attendance_comparison.status).toBe('not_applicable');
    await complete();
    const history = await t.run(ctx => ctx.db.query('shiftCloseoutHistory').collect());
    expect(history).toHaveLength(3);
    expect(history[1].before?.signedAttendanceEvidence).toEqual(before?.signedAttendanceEvidence);
    expect(history[2].after.signedAttendanceEvidence?.raw_punches).toBe(1);
    expect((await actor.query(api.shiftCloseouts.get, { date })).attendance_comparison.status).toBe('unchanged');
  });

  it('detects equal-count edits and correction/reversal sequences restoring effective attendance', async () => {
    const { t, actor, complete, workerId } = await setup();
    const id = await t.run(ctx => ctx.db.insert('attendance', { workerId, eventType: 'clock_in', timestamp: '2026-09-02T08:00:00', synced: true }));
    await complete();
    await t.run(ctx => ctx.db.patch(id, { note: 'Metadata with audit meaning' }));
    expect((await actor.query(api.shiftCloseouts.get, { date })).attendance_comparison).toMatchObject({ status: 'changed', signed: { raw_punches: 1 }, current: { raw_punches: 1 } });
    await t.run(ctx => ctx.db.patch(id, { note: undefined }));
    expect((await actor.query(api.shiftCloseouts.get, { date })).attendance_comparison.status).toBe('unchanged');
    const initialEffective = await actor.query(api.attendance.list, { date });
    const correctionId = (await actor.mutation(api.attendanceCorrections.create, { date, workerId, action: 'void_event', originalAttendanceId: id, reason: 'Mistaken punch' })).id;
    expect((await actor.query(api.shiftCloseouts.get, { date })).attendance_comparison.status).toBe('changed');
    await actor.mutation(api.attendanceCorrections.reverse, { correctionId, reason: 'Restore punch', requestId: 'synthetic-reversal' });
    const restored = await actor.query(api.shiftCloseouts.get, { date });
    expect(restored.attendance_comparison).toMatchObject({ status: 'changed', current: { raw_punches: 1, corrections: 1, reversals: 1 } });
    expect(await actor.query(api.attendance.list, { date })).toEqual(initialEffective);
    const addition = await actor.mutation(api.attendanceCorrections.create, { date, workerId, action: 'add_clock_out', correctedTimestamp: '2026-09-02T17:00:00', reason: 'Missed departure' });
    await actor.mutation(api.attendanceCorrections.reverse, { correctionId: addition.id, reason: 'Found raw evidence', requestId: 'synthetic-add-reversal' });
    expect((await actor.query(api.shiftCloseouts.get, { date })).attendance_comparison).toMatchObject({ status: 'changed', current: { corrections: 2, reversals: 2 } });
    expect(await actor.query(api.attendance.list, { date })).toEqual(initialEffective);
  });

  it.each([
    ['2026-09-02', '2026-09-02T04:59:59.999Z', '2026-09-02T05:00:00Z'],
    ['2026-09-02', '2026-09-01T23:59:59-05:00', '2026-09-02T05:30:00Z'],
    ['2026-03-08', '2026-03-08T05:59:59Z', '2026-03-08T06:00:00Z'],
    ['2026-11-01', '2026-11-01T04:59:59Z', '2026-11-01T07:30:00Z'],
    ['2026-11-01', '2026-11-02T06:00:00Z', '2026-11-01T01:30:00-05:00'],
  ])('owns Chicago date %s across midnight/DST', async (selected, outside, inside) => {
    const { t, actor, complete, workerId } = await setup();
    await complete(selected);
    await t.mutation(internal.attendance.bulkCreateFromHttp, { events: [{ workerId, eventType: 'clock_in', timestamp: outside }] });
    expect((await actor.query(api.shiftCloseouts.get, { date: selected })).attendance_comparison.status).toBe('unchanged');
    await t.mutation(internal.attendance.bulkCreateFromHttp, { events: [{ workerId, eventType: 'clock_in', timestamp: inside }] });
    expect((await actor.query(api.shiftCloseouts.get, { date: selected })).attendance_comparison).toMatchObject({ status: 'changed', current: { raw_punches: 1 } });
  });

  it('keeps legacy/unsupported signatures unknown without backfill and enforces roles', async () => {
    const { t, actor, complete, viewerId } = await setup();
    const { id } = await complete();
    await t.run(ctx => ctx.db.patch(id, { signedAttendanceEvidence: undefined }));
    const before = await t.run(ctx => ctx.db.get(id));
    const viewer = t.withIdentity({ subject: viewerId });
    expect((await viewer.query(api.shiftCloseouts.get, { date })).attendance_comparison).toMatchObject({ status: 'unknown', signed: null, current: null });
    expect(await t.run(ctx => ctx.db.get(id))).toEqual(before);
    await actor.mutation(api.shiftCloseouts.save, { date, action: 'complete' });
    expect(await t.run(ctx => ctx.db.get(id))).toEqual(before);
    await t.run(ctx => ctx.db.patch(id, { signedAttendanceEvidence: { version: 2, digest: 'future', raw_punches: 0, corrections: 0, reversals: 0 } }));
    expect((await actor.query(api.shiftCloseouts.get, { date })).attendance_comparison.status).toBe('unknown');
    await expect(t.query(api.shiftCloseouts.get, { date })).rejects.toThrow('Unauthorized');
    for (const action of ['save', 'complete', 'reopen'] as const) await expect(viewer.mutation(api.shiftCloseouts.save, { date, action })).rejects.toThrow();
  });

  it('retains a signed baseline when comparison reads fail', async () => {
    const signed = buildSignedAttendanceEvidence(date, { raw: [], corrections: [], reversals: [] });
    const ctx = { db: { query: vi.fn(() => { throw new Error('unavailable'); }) } } as unknown as Parameters<typeof compareSignedAttendanceEvidence>[0];
    expect(await compareSignedAttendanceEvidence(ctx, date, { status: 'completed', signedAttendanceEvidence: signed } as Doc<'shiftCloseouts'>)).toMatchObject({ status: 'unknown', signed, current: null, compared_at: null });
  });
  it('ignores labels, heartbeats, unrelated dates and leaves reads completely immutable', async () => {
    const { t, actor, complete, workerId } = await setup();
    const { id } = await complete();
    const before = await t.run(async ctx => ({ record: await ctx.db.get(id), history: await ctx.db.query('shiftCloseoutHistory').collect() }));
    await t.run(async ctx => {
      await ctx.db.patch(workerId, { name: 'New display label' });
      await ctx.db.insert('attendance', { workerId, timestamp: '2026-09-05T12:00:00Z', eventType: 'clock_in', synced: true });
      await ctx.db.insert('kiosks', { name: 'Renamed gate', type: 'entry', location: 'Test', active: false, lastSync: '2026-09-02T18:00:00Z' });
    });
    for (let i = 0; i < 2; i++) expect((await actor.query(api.shiftCloseouts.get, { date })).attendance_comparison.status).toBe('unchanged');
    expect(await t.run(async ctx => ({ record: await ctx.db.get(id), history: await ctx.db.query('shiftCloseoutHistory').collect() }))).toEqual(before);
  });

  it('rolls back completion if the new baseline cannot be safely captured', async () => {
    const { t, actor, complete, workerId } = await setup();
    // Each row remains under the document limit; the combined signature input exceeds its bound.
    await t.run(async ctx => {
      for (let i = 0; i <= MAX_CANONICAL_BYTES / 700000; i++) await ctx.db.insert('attendance', { workerId, timestamp: `2026-09-02T08:00:${String(i).padStart(2, '0')}`, eventType: 'clock_in', synced: true, note: 'x'.repeat(700000) });
    });
    await expect(complete()).rejects.toThrow('safe comparison size');
    expect((await actor.query(api.shiftCloseouts.get, { date })).closeout).toBeNull();
    expect(await t.run(ctx => ctx.db.query('shiftCloseoutHistory').collect())).toEqual([]);
  });

});
