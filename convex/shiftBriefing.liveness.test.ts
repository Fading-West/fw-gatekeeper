/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';
import { KIOSK_DEGRADED_REASON_LABELS } from '../src/lib/kiosk-health-labels';

const modules = import.meta.glob('./**/*.ts');

describe('required liveness in shift trust', () => {
  it('treats a fresh kiosk with failed required verification as scan-blocking and clears on recovery', async () => {
    const t = convexTest(schema, modules);
    const now = new Date().toISOString();
    const { userId, kioskId } = await t.run(async ctx => {
      const userId = await ctx.db.insert('users', { email: 'reviewer@example.com' });
      await ctx.db.insert('portalMembers', { userId, role: 'admin', active: true, createdAt: now });
      const kioskId = await ctx.db.insert('kiosks', {
        name: 'Entry', kioskId: 'entry-1', type: 'entry', location: 'Factory door', active: true,
        lastSync: now, health: { cameraOk: true, modelOk: true, livenessAvailable: false,
          degradedReason: 'liveness_required_unavailable', reportedAt: now },
      });
      return { userId, kioskId };
    });
    const admin = t.withIdentity({ subject: userId });
    const failed = await admin.query(api.shiftBriefing.summary, { date: '2026-09-01' });
    expect(failed.kiosks.rows[0]).toMatchObject({ status: 'online', device_fault: true });
    expect(failed.summary.kiosk_warnings).toBe(1);
    expect(failed.shift_trust_brief.readiness_blockers).toContainEqual(expect.objectContaining({ id: 'kiosk:device-fault', severity: 'critical' }));
    expect(KIOSK_DEGRADED_REASON_LABELS.liveness_required_unavailable).toContain('automatic attendance is paused');

    await t.run(ctx => ctx.db.patch(kioskId, { health: { cameraOk: true, modelOk: true, livenessAvailable: true, reportedAt: now } }));
    const recovered = await admin.query(api.shiftBriefing.summary, { date: '2026-09-01' });
    expect(recovered.kiosks.rows[0].device_fault).toBe(false);
    expect(recovered.summary.kiosk_warnings).toBe(0);
    expect(recovered.shift_trust_brief.readiness_blockers.some(item => item.id === 'kiosk:device-fault')).toBe(false);

    await t.run(ctx => ctx.db.patch(kioskId, { health: { cameraOk: true, modelOk: true, livenessAvailable: false, degradedReason: 'liveness_unavailable', reportedAt: now } }));
    const optional = await admin.query(api.shiftBriefing.summary, { date: '2026-09-01' });
    expect(optional.kiosks.rows[0].device_fault).toBe(false);
    expect(KIOSK_DEGRADED_REASON_LABELS.liveness_unavailable).toContain('optional');
  });
});
