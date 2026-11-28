/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';
import { buildAlertMessage, evaluateKioskAlerts, planKioskNotifications } from './alerts';
import { KIOSK_DEGRADED_REASON_LABELS } from '../src/lib/kiosk-health-labels';
import { ATTENDANCE_WRITE_FAULT_GUIDANCE, hasAttendanceWriteFault } from '../src/lib/kiosk-health-reasons';

const modules = import.meta.glob('./**/*.ts');
const date = '2026-09-01';

async function setup(degradedReason: string) {
  const t = convexTest(schema, modules);
  const now = new Date().toISOString();
  const { userId, kioskId } = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'reviewer@example.com' });
    await ctx.db.insert('portalMembers', { userId, role: 'admin', active: true, createdAt: now });
    const kioskId = await ctx.db.insert('kiosks', {
      name: 'Entry', kioskId: 'entry-1', type: 'entry', location: 'Factory door', active: true,
      lastSync: now, health: { cameraOk: true, modelOk: true, degradedReason, reportedAt: now },
    });
    return { userId, kioskId };
  });
  return { t, kioskId, now, admin: t.withIdentity({ subject: userId }) };
}

describe('attendance-write kiosk trust fault', () => {
  it('parses the reason with other faults and the quarantine clause', () => {
    expect(hasAttendanceWriteFault('no_workers_synced,clock_unsynchronized,attendance_write_failed; upload_quarantine: 1 attendance, 0 recognition')).toBe(true);
    expect(hasAttendanceWriteFault('clock_unsynchronized')).toBe(false);
    expect(hasAttendanceWriteFault(undefined)).toBe(false);
    expect(KIOSK_DEGRADED_REASON_LABELS.attendance_write_failed).toContain('verify the worker’s punch and local storage');
  });

  it('blocks Briefing and Closeout with guidance and clears only the write reason on recovery', async () => {
    const { t, admin, kioskId, now } = await setup('clock_unsynchronized,attendance_write_failed');
    const failed = await admin.query(api.shiftBriefing.summary, { date });
    expect(failed.kiosks.rows[0]).toMatchObject({ status: 'online', device_fault: true, attendance_write_failed: true });
    const blocker = failed.shift_trust_brief.readiness_blockers.find(item => item.id === 'kiosk:device-fault');
    expect(blocker).toMatchObject({ severity: 'critical' });
    expect(blocker!.description).toContain(ATTENDANCE_WRITE_FAULT_GUIDANCE);
    const action = failed.action_items.find(item => item.id.startsWith('kiosk-device:'));
    expect(action!.description).toBe(`Factory door: ${ATTENDANCE_WRITE_FAULT_GUIDANCE}`);

    const closeout = await admin.query(api.shiftCloseouts.get, { date });
    const kioskItem = closeout.checklist.find(item => item.id === 'kiosk_warnings');
    expect(kioskItem).toMatchObject({ status: 'blocked' });
    expect(kioskItem!.description).toContain(ATTENDANCE_WRITE_FAULT_GUIDANCE);
    expect(JSON.stringify(closeout.closeout_draft)).toContain(ATTENDANCE_WRITE_FAULT_GUIDANCE);

    // The next committed punch removes only the write reason; another device fault stays.
    await t.run(ctx => ctx.db.patch(kioskId, { health: { cameraOk: true, modelOk: true, degradedReason: 'no_workers_synced,clock_unsynchronized', reportedAt: now } }));
    const recovered = await admin.query(api.shiftBriefing.summary, { date });
    expect(recovered.kiosks.rows[0]).toMatchObject({ device_fault: true, attendance_write_failed: false });
    const remaining = recovered.shift_trust_brief.readiness_blockers.find(item => item.id === 'kiosk:device-fault');
    expect(remaining!.description).not.toContain(ATTENDANCE_WRITE_FAULT_GUIDANCE);
    const recoveredCloseout = await admin.query(api.shiftCloseouts.get, { date });
    expect(JSON.stringify(recoveredCloseout)).not.toContain(ATTENDANCE_WRITE_FAULT_GUIDANCE);

    await t.run(ctx => ctx.db.patch(kioskId, { health: { cameraOk: true, modelOk: true, degradedReason: 'clock_unsynchronized', reportedAt: now } }));
    const clear = await admin.query(api.shiftBriefing.summary, { date });
    expect(clear.kiosks.rows[0].device_fault).toBe(false);
  });

  it('pages a device fault with the write guidance in the alert email', () => {
    const nowMs = Date.parse('2026-09-05T03:00:00.000Z');
    const reportedAt = new Date(nowMs - 60_000).toISOString();
    const kiosk = { kioskId: 'kiosk-doc-1', name: 'Main Entry', location: 'Building A', lastSync: reportedAt,
      health: { cameraOk: true, modelOk: true, degradedReason: 'clock_unsynchronized,attendance_write_failed', reportedAt } };
    const evaluations = evaluateKioskAlerts([kiosk], nowMs);
    expect(evaluations[0].conditions).toEqual(['device_fault']);
    const plan = planKioskNotifications(evaluations, [], nowMs);
    const message = buildAlertMessage(plan.alerts[0], nowMs, 'https://example.test');
    expect(message.text).toContain(ATTENDANCE_WRITE_FAULT_GUIDANCE);
    const clockOnly = evaluateKioskAlerts([{ ...kiosk, health: { ...kiosk.health, degradedReason: 'clock_unsynchronized' } }], nowMs);
    expect(clockOnly[0].conditions).toEqual([]);
  });
});
