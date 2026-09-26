/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api, internal } from './_generated/api';
import schema from './schema';

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
});
