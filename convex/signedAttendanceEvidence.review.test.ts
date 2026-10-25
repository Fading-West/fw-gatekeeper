/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { buildSignedAttendanceEvidence, compareSignedAttendanceEvidence, MAX_ATTENDANCE_SCAN_ROWS, MAX_CANONICAL_BYTES } from './signedAttendanceEvidence';

const modules = import.meta.glob('./**/*.ts');
const date = '2026-09-02';

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'independent-review@example.invalid' });
    await ctx.db.insert('portalMembers', { userId, role: 'enrollment', active: true, createdAt: `${date}T00:00:00Z` });
    const workerId = await ctx.db.insert('workers', { name: 'Review Synthetic', department: 'QA', active: false, enrolledAt: `${date}T00:00:00Z` });
    return { userId, workerId };
  });
  const actor = t.withIdentity({ subject: ids.userId });
  return { t, actor, ...ids };
}

describe('independent signed-attendance audit probes', () => {
  it('detects persisted timestamp spelling changes even when display and instant match', async () => {
    const { t, actor, workerId } = await setup();
    const id = await t.run(ctx => ctx.db.insert('attendance', { workerId, eventType: 'clock_in', timestamp: `${date}T05:30:00.123456Z`, synced: true }));
    const { id: closeoutId } = await actor.mutation(api.shiftCloseouts.save, { date, action: 'complete' });
    const original = await t.run(ctx => ctx.db.get(closeoutId));
    await t.run(ctx => ctx.db.patch(id, { timestamp: `${date}T00:30:00.123456-05:00` }));
    const result = await actor.query(api.shiftCloseouts.get, { date });
    expect(result.attendance_comparison).toMatchObject({ status: 'changed', signed: { raw_punches: 1 }, current: { raw_punches: 1 } });
    expect(await t.run(ctx => ctx.db.get(closeoutId))).toEqual(original);
  });

  it('detects a replacement punch with identical visible fields and unchanged count', async () => {
    const { t, actor, workerId } = await setup();
    const punch = { workerId, eventType: 'clock_in', timestamp: `${date}T12:00:00Z`, synced: true };
    const oldId = await t.run(ctx => ctx.db.insert('attendance', punch));
    await actor.mutation(api.shiftCloseouts.save, { date, action: 'complete' });
    await t.run(async ctx => { await ctx.db.delete(oldId); await ctx.db.insert('attendance', punch); });
    expect((await actor.query(api.shiftCloseouts.get, { date })).attendance_comparison).toMatchObject({ status: 'changed', signed: { raw_punches: 1 }, current: { raw_punches: 1 } });
  });

  it('treats a truncated conservative range as unknown and preserves its signed baseline', async () => {
    const signed = buildSignedAttendanceEvidence(date, { raw: [], corrections: [], reversals: [] });
    const db = { query: vi.fn(() => ({ withIndex: () => ({ take: () => Array.from({ length: MAX_ATTENDANCE_SCAN_ROWS + 1 }, () => ({})) }) })) };
    const result = await compareSignedAttendanceEvidence({ db } as unknown as Parameters<typeof compareSignedAttendanceEvidence>[0], date, { status: 'completed', signedAttendanceEvidence: signed } as Doc<'shiftCloseouts'>);
    expect(result).toMatchObject({ status: 'unknown', signed, current: null, compared_at: null });
    expect(db.query).toHaveBeenCalledOnce();
  });

  it('keeps a valid signature available when malformed duplicate reversal evidence appears later', async () => {
    const { t, actor, workerId, userId } = await setup();
    const { id } = await actor.mutation(api.shiftCloseouts.save, { date, action: 'complete' });
    const original = await t.run(ctx => ctx.db.get(id));
    await t.run(async ctx => {
      const correctionId = await ctx.db.insert('attendanceCorrections', { date, workerId, action: 'add_clock_out', eventType: 'clock_out', correctedTimestamp: `${date}T17:00:00`, reason: 'audit reason', actorUserId: userId, createdAt: 'created', updatedAt: 'updated' });
      for (const requestId of ['first', 'duplicate']) await ctx.db.insert('attendanceCorrectionReversals', { correctionId, requestId, date, workerId, reason: 'audit reversal', actorUserId: userId, createdAt: 'later' });
    });
    const result = await t.run(ctx => compareSignedAttendanceEvidence(ctx, date, original));
    expect(result).toMatchObject({ status: 'unknown', signed: original?.signedAttendanceEvidence, current: null });
    expect(await t.run(ctx => ctx.db.get(id))).toEqual(original);
  });

  it('preserves the signed record through the full query when comparison byte limits are reached', async () => {
    const { t, actor, workerId } = await setup();
    const { id } = await actor.mutation(api.shiftCloseouts.save, { date, action: 'complete', notes: 'Original signed note' });
    const original = await t.run(ctx => ctx.db.get(id));
    await t.run(async ctx => {
      for (let i = 0; i <= MAX_CANONICAL_BYTES / 700000; i++) await ctx.db.insert('attendance', { workerId, eventType: 'clock_in', timestamp: `${date}T12:00:${String(i).padStart(2, '0')}Z`, synced: true, note: 'x'.repeat(700000) });
    });
    const result = await actor.query(api.shiftCloseouts.get, { date });
    expect(result.closeout?.notes).toBe('Original signed note');
    expect(result.attendance_comparison).toMatchObject({ status: 'unknown', signed: original?.signedAttendanceEvidence, current: null });
    expect(await t.run(ctx => ctx.db.get(id))).toEqual(original);
  });

  it('returns only digest/counts rather than attendance audit identities or notes', async () => {
    const { t, actor, workerId } = await setup();
    await t.run(ctx => ctx.db.insert('attendance', { workerId, eventType: 'clock_in', timestamp: `${date}T12:00:00Z`, synced: true, note: 'Private raw evidence note' }));
    await actor.mutation(api.shiftCloseouts.save, { date, action: 'complete' });
    const result = await actor.query(api.shiftCloseouts.get, { date });
    expect(result.attendance_comparison.status).toBe('unchanged');
    for (const side of [result.attendance_comparison.signed, result.attendance_comparison.current]) {
      expect(Object.keys(side!).sort()).toEqual(['corrections', 'digest', 'raw_punches', 'reversals', 'version']);
      expect(JSON.stringify(side)).not.toContain('Private raw evidence note');
      expect(JSON.stringify(side)).not.toContain(workerId);
    }
  });
});
