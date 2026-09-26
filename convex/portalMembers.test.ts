/// <reference types="vite/client" />

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';

import { api, internal } from './_generated/api';
import schema from './schema';
import * as audit from './audit';

const modules = import.meta.glob('./**/*.ts');

async function setup() {
  const t = convexTest(schema, modules);
  const rows = await t.run(async (ctx) => {
    const admin = await ctx.db.insert('users', { email: 'admin@example.com' });
    const second = await ctx.db.insert('users', { email: 'second@example.com' });
    const viewer = await ctx.db.insert('users', { email: 'viewer@example.com' });
    const now = new Date().toISOString();
    const adminMember = await ctx.db.insert('portalMembers', { userId: admin, role: 'admin', active: true, createdAt: now });
    const secondMember = await ctx.db.insert('portalMembers', { userId: second, role: 'admin', active: true, createdAt: now });
    const viewerMember = await ctx.db.insert('portalMembers', { userId: viewer, role: 'viewer', active: true, createdAt: now });
    const viewerSession = await ctx.db.insert('authSessions', { userId: viewer, expirationTime: Date.now() + 60000 });
    const viewerToken = await ctx.db.insert('authRefreshTokens', { sessionId: viewerSession, expirationTime: Date.now() + 60000 });
    return { admin, second, viewer, adminMember, secondMember, viewerMember, viewerSession, viewerToken };
  });
  return { t, ...rows };
}

describe('portal member lifecycle', () => {
  it('allows only admins to change roles or status and audits changes', async () => {
    const { t, admin, viewer, viewerMember } = await setup();
    const actor = t.withIdentity({ subject: admin });
    const viewerActor = t.withIdentity({ subject: viewer });
    await expect(viewerActor.mutation(api.portalMembers.setRole, { userId: admin, role: 'viewer' })).rejects.toThrow('Insufficient permissions');
    await expect(t.mutation(api.portalMembers.setActive, { userId: viewer, active: false })).rejects.toThrow('Unauthorized');
    await actor.mutation(api.portalMembers.setRole, { userId: viewer, role: 'enrollment' });
    await actor.mutation(api.portalMembers.setActive, { userId: viewer, active: false });
    const state = await t.run(async (ctx) => ({
      member: await ctx.db.get(viewerMember),
      audit: await ctx.db.query('auditLog').withIndex('by_target', (q) => q.eq('targetTable', 'portalMembers').eq('targetId', viewerMember)).collect(),
    }));
    expect(state.member).toMatchObject({ role: 'enrollment', active: false });
    expect(state.audit.map((row) => row.action)).toEqual(['portalMembers.setRole', 'portalMembers.disable']);
    expect(state.audit.every((row) => row.actorUserId === admin)).toBe(true);
  });

  it('rejects removing the last active admin, including concurrent changes', async () => {
    const { t, admin, second, adminMember, secondMember } = await setup();
    const firstActor = t.withIdentity({ subject: admin });
    const secondActor = t.withIdentity({ subject: second });
    const results = await Promise.allSettled([
      firstActor.mutation(api.portalMembers.setActive, { userId: admin, active: false }),
      secondActor.mutation(api.portalMembers.setRole, { userId: second, role: 'viewer' }),
    ]);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const remaining = await t.run(async (ctx) => [await ctx.db.get(adminMember), await ctx.db.get(secondMember)]);
    expect(remaining.filter((row) => row?.active && row.role === 'admin')).toHaveLength(1);
  });

  it('revokes sessions and denies stale JWTs after reactivation', async () => {
    const { t, admin, viewer, viewerSession, viewerToken } = await setup();
    const actor = t.withIdentity({ subject: admin });
    const oldJwt = t.withIdentity({ subject: `${viewer}|${viewerSession}` });
    const survivingSession = await t.run((ctx) => ctx.db.insert('authSessions', { userId: viewer, expirationTime: Date.now() + 60000 }));
    const survivingJwt = t.withIdentity({ subject: `${viewer}|${survivingSession}` });
    await expect(oldJwt.query(api.portalMembers.current, {})).resolves.toMatchObject({ role: 'viewer' });
    await actor.mutation(api.portalMembers.setActive, { userId: viewer, active: false });
    await expect(oldJwt.query(api.portalMembers.current, {})).resolves.toBeNull();
    await t.run(async (ctx) => {
      expect(await ctx.db.get(viewerSession)).toBeNull();
      expect(await ctx.db.get(viewerToken)).toBeNull();
      expect(await ctx.db.get(survivingSession)).not.toBeNull();
    });
    await actor.mutation(api.portalMembers.setActive, { userId: viewer, active: true });
    await expect(oldJwt.query(api.portalMembers.current, {})).resolves.toBeNull();
    await expect(survivingJwt.query(api.portalMembers.current, {})).resolves.toBeNull();
    await expect(survivingJwt.mutation(api.portalMembers.setRole, { userId: viewer, role: 'admin' })).rejects.toThrow('Unauthorized');
    await expect(t.withIdentity({ subject: viewer }).query(api.portalMembers.current, {})).resolves.toBeNull();
    const newSession = await t.run((ctx) => ctx.db.insert('authSessions', { userId: viewer, expirationTime: Date.now() + 60000 }));
    await expect(t.withIdentity({ subject: `${viewer}|${newSession}` }).query(api.portalMembers.current, {})).resolves.toMatchObject({ role: 'viewer' });
  });

  it('guards the reset-password role path before changing credentials', async () => {
    const { t, admin, second, adminMember } = await setup();
    const actor = t.withIdentity({ subject: second });
    await actor.mutation(api.portalMembers.setActive, { userId: second, active: false });
    await t.run(async (ctx) => {
      await ctx.db.insert('authAccounts', { userId: admin, provider: 'password', providerAccountId: 'admin@example.com', secret: 'unchanged' });
    });
    await expect(t.withIdentity({ subject: admin }).action(api.portalMembers.resetPortalAccountPassword, {
      email: 'admin@example.com', password: 'UpdatedPass123!', role: 'viewer',
    })).rejects.toThrow('Cannot remove the last active administrator');
    const state = await t.run(async (ctx) => ({
      member: await ctx.db.get(adminMember),
      account: await ctx.db.query('authAccounts').withIndex('providerAndAccountId', (q) => q.eq('provider', 'password').eq('providerAccountId', 'admin@example.com')).unique(),
    }));
    expect(state.member).toMatchObject({ role: 'admin', active: true });
    expect(state.account?.secret).toBe('unchanged');
  });

  it('keeps a disabled member disabled during password-reset role updates', async () => {
    const { t, admin, viewer, viewerMember } = await setup();
    const actor = t.withIdentity({ subject: admin });
    await actor.mutation(api.portalMembers.setActive, { userId: viewer, active: false });
    await t.run((ctx) => ctx.db.insert('authAccounts', { userId: viewer, provider: 'password', providerAccountId: 'viewer@example.com', secret: 'old' }));
    await actor.action(api.portalMembers.resetPortalAccountPassword, {
      email: 'viewer@example.com', password: 'UpdatedPass123!', role: 'viewer',
    });
    expect(await t.run((ctx) => ctx.db.get(viewerMember))).toMatchObject({ active: false, role: 'viewer' });
    await expect(t.action(api.auth.signIn, {
      provider: 'password', params: { email: 'viewer@example.com', password: 'UpdatedPass123!', flow: 'signIn' },
    })).rejects.toThrow('Portal account is disabled');
    const audit = await t.run((ctx) => ctx.db.query('auditLog')
      .withIndex('by_target', (q) => q.eq('targetTable', 'portalMembers').eq('targetId', viewerMember)).collect());
    expect(audit.map((row) => row.action)).toContain('portalMembers.resetPassword');
  });

  it('rejects a self-reset role change before updating credentials', async () => {
    const { t, admin, adminMember } = await setup();
    await t.run((ctx) => ctx.db.insert('authAccounts', { userId: admin, provider: 'password', providerAccountId: 'admin@example.com', secret: 'unchanged' }));
    await expect(t.withIdentity({ subject: admin }).action(api.portalMembers.resetPortalAccountPassword, {
      email: 'admin@example.com', password: 'UpdatedPass123!', role: 'viewer',
    })).rejects.toThrow('Change the account role separately');
    const state = await t.run(async (ctx) => ({
      member: await ctx.db.get(adminMember),
      account: await ctx.db.query('authAccounts').withIndex('providerAndAccountId', (q) => q.eq('provider', 'password').eq('providerAccountId', 'admin@example.com')).unique(),
    }));
    expect(state.member).toMatchObject({ role: 'admin', active: true });
    expect(state.account?.secret).toBe('unchanged');
  });
});


it('revokes sessions created earlier in the same millisecond', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-25T18:00:00Z'));
  try {
    const { t, admin, viewer, viewerSession } = await setup();
    const actor = t.withIdentity({ subject: admin });
    const oldJwt = t.withIdentity({ subject: `${viewer}|${viewerSession}` });
    await actor.mutation(api.portalMembers.setActive, { userId: viewer, active: false });
    await actor.mutation(api.portalMembers.setActive, { userId: viewer, active: true });
    await expect(oldJwt.query(api.portalMembers.current, {})).resolves.toBeNull();
    const freshSession = await t.run(ctx => ctx.db.insert('authSessions', {
      userId: viewer, expirationTime: Date.now() + 60_000,
    }));
    await expect(t.withIdentity({ subject: `${viewer}|${freshSession}` })
      .query(api.portalMembers.current, {})).resolves.toMatchObject({ role: 'viewer' });
  } finally {
    vi.useRealTimers();
  }
});

it('rolls back the password write if the audit step fails in the same mutation', async () => {
  const { t, admin, viewer } = await setup();
  await t.run(ctx => ctx.db.insert('authAccounts', {
    userId: viewer, provider: 'password', providerAccountId: 'viewer@example.com', secret: 'old',
  }));
  const spy = vi.spyOn(audit, 'writeAuditLog').mockRejectedValueOnce(new Error('audit failed'));
  try {
    await expect(t.withIdentity({ subject: admin }).mutation(internal.portalMembers.resetAccountPassword, {
      email: 'viewer@example.com', password: 'UpdatedPass123!', role: 'viewer',
    })).rejects.toThrow('audit failed');
    const state = await t.run(async ctx => ({
      account: await ctx.db.query('authAccounts').withIndex('providerAndAccountId', q => q.eq('provider', 'password').eq('providerAccountId', 'viewer@example.com')).unique(),
      member: await ctx.db.query('portalMembers').withIndex('by_user', q => q.eq('userId', viewer)).unique(),
    }));
    expect(state.account?.secret).toBe('old');
    expect(state.member?.sessionRevokedAt).toBeUndefined();
  } finally {
    spy.mockRestore();
  }
});

it('resets a password with an audit and immediate session cutoff, while rejecting a nonadmin', async () => {
  const { t, admin, viewer, viewerMember, viewerSession } = await setup();
  await t.run(ctx => ctx.db.insert('authAccounts', {
    userId: viewer, provider: 'password', providerAccountId: 'viewer@example.com', secret: 'old',
  }));
  const args = { email: 'viewer@example.com', password: 'UpdatedPass123!', role: 'viewer' as const };
  await expect(t.withIdentity({ subject: viewer }).mutation(internal.portalMembers.resetAccountPassword, args))
    .rejects.toThrow('Insufficient permissions');
  const startedAt = Date.now();
  await t.withIdentity({ subject: admin }).mutation(internal.portalMembers.resetAccountPassword, args);
  const state = await t.run(async ctx => ({
    account: await ctx.db.query('authAccounts').withIndex('providerAndAccountId', q => q.eq('provider', 'password').eq('providerAccountId', args.email)).unique(),
    member: await ctx.db.get(viewerMember),
    audit: await ctx.db.query('auditLog').withIndex('by_target', q => q.eq('targetTable', 'portalMembers').eq('targetId', viewerMember)).collect(),
  }));
  expect(state.account?.secret).not.toBe('old');
  expect(state.member?.sessionRevokedAt).toBeGreaterThanOrEqual(startedAt);
  expect(state.audit).toMatchObject([{ actorUserId: admin, action: 'portalMembers.resetPassword' }]);
  expect(await t.run(ctx => ctx.db.get(viewerSession))).toBeNull();
  expect(await t.withIdentity({ subject: `${viewer}|${viewerSession}` }).query(api.portalMembers.current, {})).toBeNull();
});
