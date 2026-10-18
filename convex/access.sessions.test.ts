/// <reference types="vite/client" />

import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';

import { api } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.ts');
const schedule = { name: 'Session-protected shift', days: '[1]', startTime: '08:00', endTime: '17:00' };

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert('users', { email: 'admin@example.com' });
    await ctx.db.insert('portalMembers', {
      userId, role: 'admin', active: true, createdAt: new Date().toISOString(),
    });
    const sessionId = await ctx.db.insert('authSessions', { userId, expirationTime: Date.now() + 60_000 });
    const otherSessionId = await ctx.db.insert('authSessions', { userId, expirationTime: Date.now() + 60_000 });
    const refreshTokenId = await ctx.db.insert('authRefreshTokens', { sessionId, expirationTime: Date.now() + 60_000 });
    return { userId, sessionId, otherSessionId, refreshTokenId };
  });
  return { t, ...ids, actor: t.withIdentity({ subject: `${ids.userId}|${ids.sessionId}` }) };
}

describe('Convex Auth session boundaries before any account reset or disable', () => {
  it('denies portal reads immediately after the real sign-out action deletes the session', async () => {
    const { t, actor, sessionId, refreshTokenId } = await setup();
    await expect(actor.query(api.portalMembers.current, {})).resolves.toMatchObject({ role: 'admin' });
    await actor.action(api.auth.signOut, {});
    await t.run(async (ctx) => {
      expect(await ctx.db.get(sessionId)).toBeNull();
      expect(await ctx.db.get(refreshTokenId)).toBeNull();
    });
    // Reuse the identity from the still-unexpired JWT, as a replaying client can.
    await expect(actor.query(api.portalMembers.current, {})).resolves.toBeNull();
    await expect(actor.query(api.workers.list, {})).rejects.toThrow('Unauthorized');
  });

  it('denies admin mutations with a signed-out identity while leaving another session usable', async () => {
    const { t, actor, userId, otherSessionId } = await setup();
    await actor.action(api.auth.signOut, {});
    await expect(actor.mutation(api.schedules.create, schedule)).rejects.toThrow('Unauthorized');
    await expect(t.withIdentity({ subject: `${userId}|${otherSessionId}` })
      .mutation(api.schedules.create, schedule)).resolves.toMatchObject({ id: expect.any(String) });
  });

  it('denies account-management actions with a signed-out identity', async () => {
    const { actor } = await setup();
    await actor.action(api.auth.signOut, {});
    await expect(actor.action(api.portalMembers.createPortalAccount, {
      email: 'unauthorized@example.com', password: 'ValidPassword123!', role: 'admin',
    })).rejects.toThrow('Admin access required');
  });

  it('denies an expired session even while its JWT identity is still accepted by the transport', async () => {
    const { t, actor, sessionId } = await setup();
    await t.run((ctx) => ctx.db.patch(sessionId, { expirationTime: Date.now() - 1 }));
    await expect(actor.query(api.portalMembers.current, {})).resolves.toBeNull();
    await expect(actor.mutation(api.schedules.create, schedule)).rejects.toThrow('Unauthorized');
  });

  it('checks that the referenced session belongs to the authenticated user', async () => {
    const { t, actor, sessionId } = await setup();
    await t.run(async (ctx) => {
      const other = await ctx.db.insert('users', { email: 'other@example.com' });
      await ctx.db.patch(sessionId, { userId: other });
    });
    await expect(actor.query(api.portalMembers.current, {})).resolves.toBeNull();
  });

  it('allows a live session that belongs to the active member', async () => {
    const { actor } = await setup();
    await expect(actor.query(api.portalMembers.current, {})).resolves.toMatchObject({ role: 'admin' });
    await expect(actor.mutation(api.schedules.create, schedule)).resolves.toMatchObject({ id: expect.any(String) });
  });

  it('fails closed for missing, malformed, and wrong-table session IDs', async () => {
    const { t, userId } = await setup();
    for (const sessionId of ['', 'invalid-session-id', userId]) {
      const actor = t.withIdentity({ subject: `${userId}|${sessionId}` });
      await expect(actor.query(api.portalMembers.current, {})).resolves.toBeNull();
      await expect(actor.mutation(api.schedules.create, schedule)).rejects.toThrow('Unauthorized');
    }
  });
});
