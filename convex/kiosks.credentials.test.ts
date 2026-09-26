/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api, internal } from './_generated/api';
import schema from './schema';
import { kioskEvidenceId } from '../src/lib/kiosk-device-auth';

const modules = import.meta.glob('./**/*.ts');
const firstHash = 'a'.repeat(64);
const secondHash = 'b'.repeat(64);

async function setup() {
  const t = convexTest(schema, modules);
  const { userId, kioskId } = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'admin@example.test' });
    await ctx.db.insert('portalMembers', { userId, role: 'admin', active: true, createdAt: '2026-09-25' });
    const kioskId = await ctx.db.insert('kiosks', { name: 'Front', kioskId: 'entry', type: 'entry', location: '', active: true });
    return { userId, kioskId };
  });
  return { t, admin: t.withIdentity({ subject: userId }), kioskId, userId };
}

describe('device credentials', () => {
  it('supports staged shared-key migration, rotation, and permanent revocation with an actor audit', async () => {
    const { t, admin, kioskId, userId } = await setup();
    expect(await t.query(internal.kiosks.authenticateLegacy, { identifier: 'Front' })).toMatchObject({ kioskId: 'entry' });
    await admin.mutation(api.kiosks.rotateCredential, { id: kioskId, credentialHash: firstHash });
    expect(await t.query(internal.kiosks.authenticateLegacy, { identifier: 'entry' })).toBeNull();
    expect(await t.query(internal.kiosks.authenticateDevice, { credentialHash: firstHash })).toMatchObject({ kioskId: 'entry' });
    await admin.mutation(api.kiosks.rotateCredential, { id: kioskId, credentialHash: secondHash });
    expect(await t.query(internal.kiosks.authenticateDevice, { credentialHash: firstHash })).toBeNull();
    expect(await t.query(internal.kiosks.authenticateDevice, { credentialHash: secondHash })).toMatchObject({ kioskId: 'entry' });
    await admin.mutation(api.kiosks.revokeCredential, { id: kioskId });
    expect(await t.query(internal.kiosks.authenticateDevice, { credentialHash: secondHash })).toBeNull();
    expect(await t.query(internal.kiosks.authenticateLegacy, { identifier: 'entry' })).toBeNull();
    expect(await t.run(ctx => ctx.db.get(kioskId))).not.toHaveProperty('credentialHash');
    const audit = await t.run(ctx => ctx.db.query('auditLog').withIndex('by_target', q => q.eq('targetTable', 'kiosks').eq('targetId', kioskId)).collect());
    expect(audit.map(row => [row.action, row.actorUserId])).toEqual([
      ['kiosk_credential_issued', userId], ['kiosk_credential_rotated', userId], ['kiosk_credential_revoked', userId],
    ]);
  });

  it('rejects nonadmin changes and inactive or unknown devices', async () => {
    const { t, kioskId } = await setup();
    await expect(t.mutation(api.kiosks.rotateCredential, { id: kioskId, credentialHash: firstHash })).rejects.toThrow();
    expect(await t.query(internal.kiosks.authenticateLegacy, { identifier: 'unknown' })).toBeNull();
    await t.run(ctx => ctx.db.patch(kioskId, { active: false }));
    expect(await t.query(internal.kiosks.authenticateLegacy, { identifier: 'entry' })).toBeNull();
  });

  it('keeps authenticated heartbeats bound to the document despite legacy alias collisions', async () => {
    const { t, admin, kioskId } = await setup();
    const otherId = await t.run(ctx => ctx.db.insert('kiosks', { name: 'entry', type: 'exit', location: '', active: true }));
    await admin.mutation(api.kiosks.rotateCredential, { id: kioskId, credentialHash: firstHash });
    const identity = await t.query(internal.kiosks.authenticateDevice, { credentialHash: firstHash });
    expect(identity).toMatchObject({ documentId: kioskId, kioskId: 'entry' });
    expect(await t.mutation(internal.kiosks.updateLastSyncFromHttp, { kioskId: 'entry', lastSync: '2026-09-25T10:00:00Z' })).toEqual({ updated: false });
    expect(await t.mutation(internal.kiosks.updateLastSyncFromHttp, { kioskId: identity!.documentId, lastSync: '2026-09-25T10:00:00Z' })).toEqual({ updated: true });
    expect(await t.run(ctx => ctx.db.get(kioskId))).toMatchObject({ lastSync: '2026-09-25T10:00:00Z' });
    expect(await t.run(ctx => ctx.db.get(otherId))).not.toHaveProperty('lastSync');
  });
});

it('keeps validated legacy aliases in attendance and recognition retry evidence', async () => {
  const { t } = await setup();
  const workerId = await t.run(ctx => ctx.db.insert('workers', {
    name: 'Worker', department: 'Operations', active: true, enrolledAt: '2026-09-25',
  }));
  const identity = { kioskId: 'entry', aliases: ['entry', 'Front'] };
  const event = { workerId, eventType: 'clock_in', timestamp: '2026-09-25T08:00:00', kioskId: 'Front', idempotencyKey: 'scan-1' };
  await t.mutation(internal.attendance.bulkCreateFromHttp, { events: [event] });
  const retryId = kioskEvidenceId(identity, { kioskId: 'Front' }, { kiosk_id: 'entry' });
  expect(await t.mutation(internal.attendance.bulkCreateFromHttp, { events: [{ ...event, kioskId: retryId }] }))
    .toEqual({ synced: 0, acknowledged: 1 });
  expect(await t.run(ctx => ctx.db.query('attendance').collect())).toHaveLength(1);

  const attempt = { sourceAttemptId: 'attempt-1', kioskId: 'Front', timestamp: '2026-09-25T08:00:00',
    faceDetected: true, decision: 'matched', threshold: 0.3 };
  await t.mutation(internal.recognitionAttempts.bulkIngestFromHttp, { attempts: [attempt] });
  const attemptRetryId = kioskEvidenceId(identity, { kiosk_id: 'Front', kioskId: 'entry' });
  expect(await t.mutation(internal.recognitionAttempts.bulkIngestFromHttp, { attempts: [{ ...attempt, kioskId: attemptRetryId }] }))
    .toMatchObject({ ingested: 0, skipped: 1 });
  expect(await t.run(ctx => ctx.db.query('recognitionAttempts').collect())).toHaveLength(1);
});
