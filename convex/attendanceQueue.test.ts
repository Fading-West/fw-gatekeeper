/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import type { FunctionArgs } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from './_generated/api';
import schema from './schema';
const modules = import.meta.glob('./**/*.ts');
const date = '2026-10-18';
const kioskId = 'synthetic-gate';

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'synthetic-supervisor@example.test' });
    await ctx.db.insert('portalMembers', { userId, role: 'enrollment', active: true, createdAt: date });
    const viewerId = await ctx.db.insert('users', { email: 'synthetic-viewer@example.test' });
    await ctx.db.insert('portalMembers', { userId: viewerId, role: 'viewer', active: true, createdAt: date });
    const kiosk = await ctx.db.insert('kiosks', { name: 'Synthetic gate', kioskId, type: 'entry', location: 'Synthetic', active: true });
    return { userId, viewerId, kiosk };
  });
  let clock = Date.now() - 10 * 60_000;
  // Fresh, otherwise healthy reports arrive in order unless `at` is given.
  const report = (health?: Record<string, unknown>, at?: string) => {
    const lastSync = at ?? new Date(clock += 1_000).toISOString();
    return t.mutation(internal.kiosks.updateLastSyncFromHttp, {
      kioskId, lastSync, ...(health ? { health: { cameraOk: true, modelOk: true, reportedAt: lastSync, ...health } } : {}),
    });
  };
  return { t, report, actor: t.withIdentity({ subject: ids.userId }), viewer: t.withIdentity({ subject: ids.viewerId }), ...ids };
}

let request = 0;
async function save(actor: Awaited<ReturnType<typeof setup>>['actor'], args: Omit<FunctionArgs<typeof api.shiftCloseouts.save>, 'requestId' | 'expectedRevision'>) {
  const current = await actor.query(api.shiftCloseouts.get, { date: args.date });
  return actor.mutation(api.shiftCloseouts.save, { ...args, requestId: `synthetic-queue-${++request}`,
    expectedRevision: current.closeout ? current.closeout.revision ?? 0 : null });
}
async function acknowledge(actor: Awaited<ReturnType<typeof setup>>['actor'], action: 'save' | 'complete' = 'save', notes = 'Queue reviewed with the gate supervisor') {
  const payload = await actor.query(api.shiftCloseouts.get, { date });
  return save(actor, { date, action, notes, acknowledgedBlockers: true, blockerEvidence: payload.blocker_evidence });
}
const kioskRow = async (t: Awaited<ReturnType<typeof setup>>['t'], id: Awaited<ReturnType<typeof setup>>['kiosk']) => t.run(ctx => ctx.db.get(id));

afterEach(() => vi.unstubAllEnvs());

describe('attendance queue observations', () => {
  it.each([1, 237])('flags %i pending records on a fresh, otherwise healthy kiosk', async count => {
    const { report, actor } = await setup();
    await report({ queuedLogs: count, queuedAttempts: 0 });
    const briefing = await actor.query(api.shiftBriefing.summary, { date });
    const [row] = briefing.kiosks.rows;
    expect(row).toMatchObject({ status: 'online', device_fault: false, warning_reasons: ['attendance_queue'],
      attendance_queue: { status: 'pending', last_valid_count: count, caveat: true } });
    expect(briefing.summary.kiosk_warnings).toBe(1);
    expect(briefing.kiosks.attendance_queue).toMatchObject({ scope: 'current_fleet', attendance_dates_known: false, affected_kiosks: 1, pending_records: count });
    expect(briefing.action_items.find((item: any) => item.id.startsWith('kiosk-queue:'))?.label).toContain(`${count} attendance record`);
    expect(briefing.shift_trust_brief.readiness_status).toBe('attention');
    expect(briefing.shift_trust_brief.readiness_blockers.map((risk: any) => risk.id)).toContain('kiosk:attendance-queue');
    const closeout = await actor.query(api.shiftCloseouts.get, { date });
    expect(closeout.can_complete).toBe(false);
    expect(closeout.checklist.find((item: any) => item.id === 'kiosk_warnings')).toMatchObject({ status: 'blocked', count: 1 });
    expect(closeout.checklist.find((item: any) => item.id === 'kiosk_warnings')?.description).toContain('attendance dates are unknown');
    expect(closeout.suggested_note).toContain('Incomplete attendance evidence');
    expect(closeout.closeout_draft.narrative).toContain(`${count} attendance record`);
  });

  it('counts a kiosk with several reasons once and keeps every reason', async () => {
    const { t, report, actor, kiosk } = await setup();
    await report({ queuedLogs: 4, cameraOk: false, degradedReason: 'camera_error' }, new Date(Date.now() - 20 * 60_000).toISOString());
    expect((await kioskRow(t, kiosk))?.attendanceQueue).toMatchObject({ lastValidCount: 4 });
    const briefing = await actor.query(api.shiftBriefing.summary, { date });
    expect(briefing.kiosks.rows[0].warning_reasons).toEqual(['stale', 'device_fault', 'attendance_queue']);
    expect(briefing.summary.kiosk_warnings).toBe(1);
    const risk = briefing.shift_trust_brief.closeout_risks.find((item: any) => item.id === 'closeout:kiosk-warnings');
    expect(risk).toMatchObject({ count: 1, severity: 'critical' });
    expect(risk?.description).toContain('1 stale, 1 reporting a device fault, 1 holding attendance not yet uploaded');
    expect((await actor.query(api.shiftCloseouts.get, { date })).summary.kiosk_warnings).toBe(1);
  });

  it('keeps unresolved positive evidence through unknown reports and contact without refreshing its time', async () => {
    const { t, report, actor, kiosk } = await setup();
    await report({ queuedLogs: 12 });
    const observedAt = (await kioskRow(t, kiosk))!.attendanceQueue!.observedAt;
    await report({});
    await report();
    await report({ queuedLogs: 2.5 });
    const row = await kioskRow(t, kiosk);
    expect(row?.attendanceQueue).toEqual({ lastValidCount: 12, observedAt, latest: 'unknown' });
    expect(row?.lastSync).not.toBe(observedAt);
    const briefing = await actor.query(api.shiftBriefing.summary, { date });
    expect(briefing.kiosks.rows[0].attendance_queue).toEqual({ status: 'unknown', last_valid_count: 12, observed_at: observedAt, caveat: true });
    expect(briefing.summary.kiosk_warnings).toBe(1);
  });

  it('clears only the queue caveat on a newer accepted zero, and ignores a delayed older zero', async () => {
    const { t, report, actor, kiosk } = await setup();
    const older = new Date(Date.now() - 5 * 60_000).toISOString();
    const newer = new Date(Date.now() - 4 * 60_000).toISOString();
    await report({ queuedLogs: 3, cameraOk: false }, newer);
    await report({ queuedLogs: 0, cameraOk: false }, older);
    expect((await kioskRow(t, kiosk))?.attendanceQueue).toMatchObject({ lastValidCount: 3, observedAt: newer });
    await report({ queuedLogs: 0, cameraOk: false }, new Date(Date.now() - 60_000).toISOString());
    const briefing = await actor.query(api.shiftBriefing.summary, { date });
    expect(briefing.kiosks.rows[0]).toMatchObject({ warning_reasons: ['device_fault'], attendance_queue: { status: 'clear', last_valid_count: 0, caveat: false } });
    expect(briefing.summary.kiosk_warnings).toBe(1);
    expect(briefing.kiosks.attendance_queue.affected_kiosks).toBe(0);
  });

  it('never stores malformed or fractional counts and keeps devices without positive evidence unknown', async () => {
    const { t, report, actor, kiosk } = await setup();
    await report({ queuedLogs: 1.5, queuedAttempts: -2 });
    const row = await kioskRow(t, kiosk);
    expect(row?.health).not.toHaveProperty('queuedLogs');
    expect(row?.health).not.toHaveProperty('queuedAttempts');
    expect(row).not.toHaveProperty('attendanceQueue');
    const briefing = await actor.query(api.shiftBriefing.summary, { date });
    expect(briefing.kiosks.rows[0]).toMatchObject({ warning_reasons: [], attendance_queue: { status: 'unknown', last_valid_count: null, caveat: false } });
    expect(briefing.summary.kiosk_warnings).toBe(0);
    expect(briefing.kiosks.attendance_queue).toMatchObject({ unknown_kiosks: 1, affected_kiosks: 0 });
    const closeout = await actor.query(api.shiftCloseouts.get, { date });
    expect(closeout.can_complete).toBe(true);
    expect(closeout.checklist.find((item: any) => item.id === 'kiosk_warnings')?.description).toContain('did not include a valid attendance queue count');
  });

  it('does not treat queued recognition attempts as attendance', async () => {
    const { report, actor } = await setup();
    await report({ queuedLogs: 0, queuedAttempts: 400 });
    const briefing = await actor.query(api.shiftBriefing.summary, { date });
    expect(briefing.summary.kiosk_warnings).toBe(0);
    expect(briefing.kiosks.rows[0].attendance_queue.status).toBe('clear');
  });

  it('falls back to legacy health and initializes stored state on the next accepted update', async () => {
    const { t, report, actor, kiosk } = await setup();
    const legacyAt = new Date(Date.now() - 2 * 60_000).toISOString();
    await t.run(ctx => ctx.db.patch(kiosk, { lastSync: legacyAt, health: { cameraOk: true, modelOk: true, queuedLogs: 7, reportedAt: legacyAt } }));
    const before = await t.run(ctx => ctx.db.get(kiosk));
    // Health inspection never writes the lazily derived observation.
    expect((await actor.query(api.shiftBriefing.summary, { date })).kiosks.rows[0].attendance_queue).toMatchObject({ status: 'pending', last_valid_count: 7, observed_at: legacyAt });
    await actor.query(api.shiftCloseouts.get, { date });
    expect(await t.run(ctx => ctx.db.get(kiosk))).toEqual(before);
    await report({}, new Date(Date.now() - 60_000).toISOString());
    expect((await kioskRow(t, kiosk))?.attendanceQueue).toEqual({ lastValidCount: 7, observedAt: legacyAt, latest: 'unknown' });
  });

  it('labels the same fleet-wide unknown-date caveat for every selected date', async () => {
    const { report, actor } = await setup();
    await report({ queuedLogs: 2 });
    for (const selected of ['2026-10-01', date, '2026-10-19']) {
      const closeout = await actor.query(api.shiftCloseouts.get, { date: selected });
      expect(closeout.attendance_queue).toMatchObject({ scope: 'current_fleet', attendance_dates_known: false, pending_records: 2 });
      expect(closeout.attendance_queue.note).toContain('attendance dates are unknown');
      expect(closeout.can_complete).toBe(false);
    }
  });
});

describe('strict queue parsing at the Convex HTTP boundary', () => {
  it.each([
    ['', undefined], [null, undefined], [true, undefined], [false, undefined], [1.5, undefined], [-1, undefined],
    ['01', undefined], ['1e3', undefined], [' 5', undefined], ['0x10', undefined], [Number.MAX_SAFE_INTEGER + 1, undefined],
    [0, 0], ['0', 0], [237, 237], ['237', 237],
  ])('maps queuedLogs %j to %j', async (value, expected) => {
    vi.stubEnv('CONVEX_INGEST_KEY', 'test-ingest-key');
    const { t, kiosk } = await setup();
    const response = await t.fetch('/api/ingest/kiosks/last-sync', {
      method: 'POST', headers: { authorization: 'Bearer test-ingest-key' },
      body: JSON.stringify({ kioskId, lastSync: new Date(Date.now() - 1_000).toISOString(), health: { cameraOk: true, queuedLogs: value } }),
    });
    expect(response.status).toBe(200);
    const row = await kioskRow(t, kiosk);
    expect(row?.health?.queuedLogs).toBe(expected);
    expect(row?.attendanceQueue?.lastValidCount).toBe(expected);
  });
});

describe('closeout enforcement for unsynced attendance', () => {
  it('requires acknowledgement and a nonblank reason before completion', async () => {
    const { t, report, actor } = await setup();
    await report({ queuedLogs: 5 });
    await expect(save(actor, { date, action: 'complete' })).rejects.toThrow('blockers');
    const payload = await actor.query(api.shiftCloseouts.get, { date });
    await expect(save(actor, { date, action: 'complete', acknowledgedBlockers: true, blockerEvidence: payload.blocker_evidence, notes: '   ' })).rejects.toThrow('acknowledgement note');
    expect(await t.run(ctx => ctx.db.query('shiftCloseoutHistory').collect())).toEqual([]);
  });

  it('denies viewer and anonymous writes', async () => {
    const { t, report, viewer } = await setup();
    await report({ queuedLogs: 5 });
    const payload = await viewer.query(api.shiftCloseouts.get, { date });
    const args = { date, action: 'complete' as const, requestId: 'synthetic-denied', expectedRevision: null, notes: 'Viewer', acknowledgedBlockers: true, blockerEvidence: payload.blocker_evidence };
    await expect(viewer.mutation(api.shiftCloseouts.save, args)).rejects.toThrow();
    await expect(t.mutation(api.shiftCloseouts.save, args)).rejects.toThrow();
    expect(await t.run(ctx => ctx.db.query('shiftCloseouts').collect())).toEqual([]);
  });

  it('records actor, history and immutable queue proof that retries cannot rewrite', async () => {
    const { t, report, actor, userId, kiosk } = await setup();
    await report({ queuedLogs: 9 });
    const payload = await actor.query(api.shiftCloseouts.get, { date });
    const args = { date, action: 'complete' as const, requestId: 'synthetic-signoff', expectedRevision: null, notes: 'Reviewed queued attendance', acknowledgedBlockers: true, blockerEvidence: payload.blocker_evidence };
    const signed = await actor.mutation(api.shiftCloseouts.save, args);
    const record = await t.run(ctx => ctx.db.get(signed.id));
    expect(record?.attendanceQueueEvidence).toMatchObject({ affectedKiosks: 1, pendingRecords: 9, omittedKiosks: 0,
      kiosks: [{ id: String(kiosk), name: 'Synthetic gate', kioskId, status: 'pending', lastValidCount: 9 }] });
    const [history] = await t.run(ctx => ctx.db.query('shiftCloseoutHistory').collect());
    expect(history).toMatchObject({ actorUserId: userId, action: 'complete', after: { attendanceQueueEvidence: record!.attendanceQueueEvidence } });

    // The queue clears, then the same request and a fresh complete both retry.
    await report({ queuedLogs: 0 });
    expect(await actor.mutation(api.shiftCloseouts.save, args)).toEqual(signed);
    await save(actor, { date, action: 'complete', notes: 'Retry' });
    expect(await t.run(ctx => ctx.db.get(signed.id))).toEqual(record);
    expect(await t.run(ctx => ctx.db.query('shiftCloseoutHistory').collect())).toHaveLength(1);
    const current = await actor.query(api.shiftCloseouts.get, { date });
    expect(current.closeout?.signed_attendance_queue).toMatchObject({ pending_records: 9, kiosks: [{ status: 'pending', last_valid_count: 9, caveat: true }] });
    expect(current.attendance_queue).toMatchObject({ pending_records: 0, affected_kiosks: 0 });
  });

  it('keeps older signatures unchanged and reports their queue evidence as not recorded', async () => {
    const { t, actor } = await setup();
    const id = await t.run(ctx => ctx.db.insert('shiftCloseouts', { date, status: 'completed', acknowledgedBlockers: false, revision: 1,
      expected: 0, present: 0, late: 0, missing: 0, openExceptions: 0, criticalExceptions: 0, kioskWarnings: 0,
      completedAt: date, createdAt: date, updatedAt: date }));
    const before = await t.run(ctx => ctx.db.get(id));
    const payload = await actor.query(api.shiftCloseouts.get, { date });
    expect(payload.closeout?.signed_attendance_queue).toBeNull();
    expect(await t.run(ctx => ctx.db.get(id))).toEqual(before);
  });

  it.each([
    ['a changed count', async (report: Awaited<ReturnType<typeof setup>>['report']) => { await report({ queuedLogs: 6 }); }],
    ['a known-to-unknown change', async (report: Awaited<ReturnType<typeof setup>>['report']) => { await report({}); }],
  ])('requires renewed acknowledgement after %s', async (_label, change) => {
    const { t, report, actor } = await setup();
    await report({ queuedLogs: 5 });
    const original = await actor.query(api.shiftCloseouts.get, { date });
    await acknowledge(actor);
    await change(report);
    const changed = await actor.query(api.shiftCloseouts.get, { date });
    expect(changed.summary.kiosk_warnings).toBe(1);
    expect(changed.closeout).toMatchObject({ acknowledged_blockers: false, acknowledgement_stale: true });
    await expect(save(actor, { date, action: 'complete', notes: 'Old review', acknowledgedBlockers: true, blockerEvidence: original.blocker_evidence }))
      .rejects.toThrow('blockers changed');
    expect(await t.run(ctx => ctx.db.query('shiftCloseoutHistory').collect())).toEqual([]);
    await acknowledge(actor, 'complete');
    expect((await actor.query(api.shiftCloseouts.get, { date })).closeout?.status).toBe('completed');
  });

  it('requires renewed acknowledgement when another kiosk reports the same count', async () => {
    const { t, report, actor } = await setup();
    await report({ queuedLogs: 5 });
    const original = await actor.query(api.shiftCloseouts.get, { date });
    await acknowledge(actor);
    await t.run(async ctx => {
      const [first] = await ctx.db.query('kiosks').collect();
      await ctx.db.patch(first._id, { attendanceQueue: { lastValidCount: 0, observedAt: new Date().toISOString(), latest: 'reported' } });
      await ctx.db.insert('kiosks', { name: 'Replacement gate', type: 'entry', location: 'Synthetic', active: true, lastSync: new Date().toISOString(),
        attendanceQueue: { lastValidCount: 5, observedAt: new Date().toISOString(), latest: 'reported' } });
    });
    const changed = await actor.query(api.shiftCloseouts.get, { date });
    expect(changed.summary.kiosk_warnings).toBe(original.summary.kiosk_warnings);
    expect(changed.blocker_evidence).not.toBe(original.blocker_evidence);
    expect(changed.closeout?.acknowledged_blockers).toBe(false);
  });

  it('keeps an acknowledgement when only heartbeat or observation times change', async () => {
    const { report, actor } = await setup();
    await report({ queuedLogs: 5 });
    const original = await actor.query(api.shiftCloseouts.get, { date });
    await acknowledge(actor);
    await report({ queuedLogs: 5 });
    await report();
    await report({ queuedLogs: 5 });
    const later = await actor.query(api.shiftCloseouts.get, { date });
    expect(later.attendance_queue?.kiosks[0].observed_at).not.toBe(original.attendance_queue?.kiosks[0].observed_at);
    expect(later.blocker_evidence).toBe(original.blocker_evidence);
    expect(later.closeout?.acknowledged_blockers).toBe(true);
    await acknowledge(actor, 'complete');
    expect((await actor.query(api.shiftCloseouts.get, { date })).closeout?.status).toBe('completed');
  });
});
