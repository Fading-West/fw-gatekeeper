/// <reference types="vite/client" />

import { generateKeyPairSync } from 'node:crypto';
import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';

import { api, internal } from './_generated/api';
import schema from './schema';
import * as audit from './audit';

const modules = import.meta.glob('./**/*.ts');

async function withLocalAuthKeys(run: () => Promise<void>) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  vi.stubEnv('JWT_PRIVATE_KEY', privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
  vi.stubEnv('CONVEX_SITE_URL', 'https://example.convex.site');
  try {
    await run();
  } finally {
    vi.unstubAllEnvs();
  }
}

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
      expect(await ctx.db.get(survivingSession)).toBeNull();
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

it('creates the password account, member, and audit in one mutation', async () => {
  const { t, admin } = await setup();
  const result = await t.withIdentity({ subject: admin }).action(api.portalMembers.createPortalAccount, {
    email: '  New.Member@Example.com  ', password: 'InitialPass123!', role: 'enrollment',
  });
  expect(result).toEqual({ email: 'new.member@example.com', role: 'enrollment', active: true });
  const state = await t.run(async ctx => {
    const account = await ctx.db.query('authAccounts')
      .withIndex('providerAndAccountId', q => q.eq('provider', 'password').eq('providerAccountId', result.email)).unique();
    const member = account ? await ctx.db.query('portalMembers').withIndex('by_user', q => q.eq('userId', account.userId)).unique() : null;
    const audit = member ? await ctx.db.query('auditLog')
      .withIndex('by_target', q => q.eq('targetTable', 'portalMembers').eq('targetId', member._id)).collect() : [];
    const alerts = await ctx.db.query('peopleAlertEvents').collect();
    return { account, member, audit, alerts };
  });
  expect(state.account?.secret).not.toBe('InitialPass123!');
  expect(state.member).toMatchObject({ role: 'enrollment', active: true });
  expect(state.audit).toMatchObject([{ actorUserId: admin, action: 'portalMembers.create' }]);
  expect(state.alerts).toMatchObject([{ kind: 'portal_account', label: 'new.member@example.com', detail: 'enrollment', delivered: false }]);
  await withLocalAuthKeys(async () => {
    await expect(t.action(api.auth.signIn, {
      provider: 'password', params: { email: result.email, password: 'InitialPass123!', flow: 'signIn' },
    })).resolves.toBeTruthy();
  });
});

it('signs in with a reset password and rejects the previous password', async () => {
  const { t, admin } = await setup();
  const actor = t.withIdentity({ subject: admin });
  await actor.action(api.portalMembers.createPortalAccount, {
    email: 'resettable@example.com', password: 'InitialPass123!', role: 'viewer',
  });
  await actor.action(api.portalMembers.resetPortalAccountPassword, {
    email: 'resettable@example.com', password: 'UpdatedPass123!', role: 'viewer',
  });
  await withLocalAuthKeys(async () => {
    await expect(t.action(api.auth.signIn, {
      provider: 'password', params: { email: 'resettable@example.com', password: 'InitialPass123!', flow: 'signIn' },
    })).rejects.toThrow();
    await expect(t.action(api.auth.signIn, {
      provider: 'password', params: { email: 'resettable@example.com', password: 'UpdatedPass123!', flow: 'signIn' },
    })).resolves.toBeTruthy();
  });
});

it('rejects creation if the admin loses access before the account mutation', async () => {
  const { t, admin, second } = await setup();
  expect(await t.withIdentity({ subject: admin }).query(internal.portalMembers.getActiveMemberByUserId, { userId: admin }))
    .toMatchObject({ role: 'admin' });
  await t.withIdentity({ subject: second }).mutation(api.portalMembers.setActive, { userId: admin, active: false });
  await expect(t.withIdentity({ subject: admin }).mutation(internal.portalMembers.createAccountAndMember, {
    email: 'stranded@example.com', password: 'InitialPass123!', role: 'viewer',
  })).rejects.toThrow('Unauthorized');
  expect(await t.run(ctx => ctx.db.query('authAccounts')
    .withIndex('providerAndAccountId', q => q.eq('provider', 'password').eq('providerAccountId', 'stranded@example.com')).unique())).toBeNull();
});

it('rolls back account and user creation if the member audit fails', async () => {
  const { t, admin } = await setup();
  const spy = vi.spyOn(audit, 'writeAuditLog').mockRejectedValueOnce(new Error('audit failed'));
  try {
    await expect(t.withIdentity({ subject: admin }).mutation(internal.portalMembers.createAccountAndMember, {
      email: 'rollback@example.com', password: 'InitialPass123!', role: 'viewer',
    })).rejects.toThrow('audit failed');
    const state = await t.run(async ctx => ({
      account: await ctx.db.query('authAccounts').withIndex('providerAndAccountId', q => q.eq('provider', 'password').eq('providerAccountId', 'rollback@example.com')).unique(),
      user: await ctx.db.query('users').withIndex('email', q => q.eq('email', 'rollback@example.com')).unique(),
      members: await ctx.db.query('portalMembers').withIndex('by_active', q => q.eq('active', true)).collect(),
    }));
    expect(state.account).toBeNull();
    expect(state.user).toBeNull();
    expect(state.members).toHaveLength(3);
  } finally {
    spy.mockRestore();
  }
});

it('cleans several old sessions per batch and leaves post-cutoff sessions intact', async () => {
  vi.useFakeTimers();
  try {
    const { t, admin, viewer } = await setup();
    await t.run(async ctx => {
      for (let index = 0; index < 22; index += 1) {
        const sessionId = await ctx.db.insert('authSessions', { userId: viewer, expirationTime: Date.now() + 60_000 });
        await ctx.db.insert('authRefreshTokens', { sessionId, expirationTime: Date.now() + 60_000 });
        await ctx.db.insert('authRefreshTokens', { sessionId, expirationTime: Date.now() + 60_000 });
      }
    });
    const actor = t.withIdentity({ subject: admin });
    await actor.mutation(api.portalMembers.setActive, { userId: viewer, active: false });
    const afterFirst = await t.run(ctx => ctx.db.query('authSessions').withIndex('userId', q => q.eq('userId', viewer)).take(30));
    expect(afterFirst).toHaveLength(13); // 10 of 23 old sessions cleared immediately.
    await actor.mutation(api.portalMembers.setActive, { userId: viewer, active: true });
    const freshId = await t.run(ctx => ctx.db.insert('authSessions', { userId: viewer, expirationTime: Date.now() + 60_000 }));
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const remaining = await t.run(ctx => ctx.db.query('authSessions').withIndex('userId', q => q.eq('userId', viewer)).take(30));
    expect(remaining.map(session => session._id)).toEqual([freshId]);
  } finally {
    vi.useRealTimers();
  }
});

it('caps refresh token cleanup per transaction and continues until complete', async () => {
  vi.useFakeTimers();
  try {
    const { t, admin, viewer, viewerSession } = await setup();
    await t.run(async ctx => {
      for (let index = 0; index < 249; index += 1) {
        await ctx.db.insert('authRefreshTokens', { sessionId: viewerSession, expirationTime: Date.now() + 60_000 });
      }
    });
    await t.withIdentity({ subject: admin }).mutation(api.portalMembers.setActive, { userId: viewer, active: false });
    const afterFirst = await t.run(ctx => ctx.db.query('authRefreshTokens')
      .withIndex('sessionId', q => q.eq('sessionId', viewerSession)).take(251));
    expect(afterFirst).toHaveLength(150);
    expect(await t.run(ctx => ctx.db.get(viewerSession))).not.toBeNull();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run(ctx => ctx.db.get(viewerSession))).toBeNull();
    expect(await t.run(ctx => ctx.db.query('authRefreshTokens')
      .withIndex('sessionId', q => q.eq('sessionId', viewerSession)).take(1))).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

async function temporaryMember(role: 'admin' | 'enrollment' | 'viewer' = 'admin') {
  const { t, admin } = await setup();
  await t.withIdentity({ subject: admin }).action(api.portalMembers.createPortalAccount, {
    email: 'temporary@example.com', password: 'TemporaryPass123!', role,
  });
  const state = await t.run(async ctx => {
    const account = await ctx.db.query('authAccounts').withIndex('providerAndAccountId', q => q.eq('provider', 'password').eq('providerAccountId', 'temporary@example.com')).unique();
    const member = await ctx.db.query('portalMembers').withIndex('by_user', q => q.eq('userId', account!.userId)).unique();
    const sessionId = await ctx.db.insert('authSessions', { userId: account!.userId, expirationTime: Date.now() + 60_000 });
    const otherSession = await ctx.db.insert('authSessions', { userId: account!.userId, expirationTime: Date.now() + 60_000 });
    const refreshToken = await ctx.db.insert('authRefreshTokens', { sessionId: otherSession, expirationTime: Date.now() + 60_000 });
    return { userId: account!.userId, memberId: member!._id, sessionId, otherSession, refreshToken, accountId: account!._id };
  });
  return { t, admin, ...state, actor: t.withIdentity({ subject: `${state.userId}|${state.sessionId}` }) };
}

describe('required password rotation', { timeout: 20_000 }, () => {
  it.each(['admin', 'enrollment', 'viewer'] as const)('sets the flag for a new %s and blocks role gates while allowing current lookup', async role => {
    const { actor, t, userId } = await temporaryMember(role);
    await expect(actor.query(api.portalMembers.current, {})).resolves.toMatchObject({ mustChangePassword: true, role });
    await expect(actor.query(api.workers.list, { includeEncodings: false })).rejects.toThrow('PASSWORD_CHANGE_REQUIRED');
    await expect(actor.mutation(api.schedules.create, { name: 'Blocked', days: '[1]', startTime: '08:00', endTime: '17:00' })).rejects.toThrow('PASSWORD_CHANGE_REQUIRED');
    await expect(actor.query(api.portalMembers.list, {})).rejects.toThrow('PASSWORD_CHANGE_REQUIRED');
    const workerId = await t.run(ctx => ctx.db.insert('workers', { name: 'Protected', department: 'Test', enrolledAt: new Date().toISOString(), active: true }));
    await expect(actor.mutation(api.workers.purgeBiometrics, { id: workerId, reason: 'Must not purge' })).rejects.toThrow('PASSWORD_CHANGE_REQUIRED');
    await expect(actor.action(api.enrollmentPhotos.upload, { photo: new Uint8Array([1]).buffer })).rejects.toThrow('PASSWORD_CHANGE_REQUIRED');
    await expect(actor.query(internal.portalMembers.getActiveMemberByUserId, { userId })).rejects.toThrow('PASSWORD_CHANGE_REQUIRED');
    await expect(actor.action(api.portalMembers.createPortalAccount, { email: 'blocked@example.com', password: 'AnotherPass123!', role: 'viewer' })).rejects.toThrow('PASSWORD_CHANGE_REQUIRED');
    await expect(actor.action(api.portalMembers.resetPortalAccountPassword, { email: 'admin@example.com', password: 'AnotherPass123!', role: 'admin' })).rejects.toThrow('PASSWORD_CHANGE_REQUIRED');
    await expect(t.query(internal.activityFeed.read, { sourceAccountId: userId, queriedAt: new Date().toISOString() }))
      .resolves.toEqual({ authorized: false, reason: 'PASSWORD_CHANGE_REQUIRED' });
  });

  it('rejects a wrong current password, persists rate limits, and leaves credentials and flag unchanged', async () => {
    const { t, actor, memberId, accountId, sessionId } = await temporaryMember();
    const before = await t.run(ctx => ctx.db.get(accountId));
    await expect(actor.action(api.portalMembers.changePassword, { currentPassword: 'WrongPass123!', newPassword: 'PrivatePass456!' })).rejects.toThrow('INVALID_CURRENT_PASSWORD');
    const after = await t.run(async ctx => ({
      member: await ctx.db.get(memberId), account: await ctx.db.get(accountId),
      session: await ctx.db.get(sessionId), rateLimits: await ctx.db.query('authRateLimits').collect(),
      audits: await ctx.db.query('auditLog').withIndex('by_target', q => q.eq('targetTable', 'portalMembers').eq('targetId', memberId)).collect(),
    }));
    expect(after.account?.secret).toBe(before?.secret);
    expect(after.member?.mustChangePassword).toBe(true);
    expect(after.session).not.toBeNull();
    expect(after.rateLimits).toHaveLength(1);
    await t.run(ctx => ctx.db.patch(after.rateLimits[0]._id, { attemptsLeft: 0, lastAttemptTime: Date.now() }));
    await expect(actor.action(api.portalMembers.changePassword, { currentPassword: 'TemporaryPass123!', newPassword: 'PrivatePass456!' })).rejects.toThrow('TOO_MANY_ATTEMPTS');
    expect(after.audits.map(row => row.action)).toEqual(['portalMembers.create']);
  });

  it('clears the flag, audits the owner, revokes sessions and old JWTs, and accepts only the new password', async () => {
    const { t, actor, userId, memberId, sessionId, otherSession, refreshToken } = await temporaryMember();
    await actor.action(api.portalMembers.changePassword, { currentPassword: 'TemporaryPass123!', newPassword: 'PrivatePass456!' });
    const state = await t.run(async ctx => ({
      member: await ctx.db.get(memberId), sessions: [await ctx.db.get(sessionId), await ctx.db.get(otherSession)],
      token: await ctx.db.get(refreshToken), audits: await ctx.db.query('auditLog').withIndex('by_target', q => q.eq('targetTable', 'portalMembers').eq('targetId', memberId)).collect(),
    }));
    expect(state.member?.mustChangePassword).toBe(false);
    expect(state.sessions).toEqual([null, null]);
    expect(state.token).toBeNull();
    expect(state.audits[1]).toMatchObject({ action: 'portalMembers.changePassword', actorUserId: userId });
    expect(state.audits[1].details).toBeUndefined();
    await expect(actor.query(api.portalMembers.current, {})).resolves.toBeNull();
    await expect(actor.query(api.workers.list, { includeEncodings: false })).rejects.toThrow('Unauthorized');
    await expect(t.withIdentity({ subject: `${userId}|${otherSession}` }).query(api.workers.list, { includeEncodings: false })).rejects.toThrow('Unauthorized');
    await withLocalAuthKeys(async () => {
      await expect(t.action(api.auth.signIn, { provider: 'password', params: { email: 'temporary@example.com', password: 'TemporaryPass123!', flow: 'signIn' } })).rejects.toThrow();
      await expect(t.action(api.auth.signIn, { provider: 'password', params: { email: 'temporary@example.com', password: 'PrivatePass456!', flow: 'signIn' } })).resolves.toBeTruthy();
    });
    const session = await t.run(ctx => ctx.db.query('authSessions').withIndex('userId', q => q.eq('userId', userId)).order('desc').first());
    const fresh = t.withIdentity({ subject: `${userId}|${session!._id}` });
    await expect(fresh.query(api.workers.list, { includeEncodings: false })).resolves.toEqual([]);
    await expect(fresh.query(api.portalMembers.current, {})).resolves.toMatchObject({ mustChangePassword: false });
  });

  it('requires rotation again after an admin reset and invalidates the previously rotated session', async () => {
    const { t, actor, admin, userId, memberId } = await temporaryMember();
    await actor.action(api.portalMembers.changePassword, { currentPassword: 'TemporaryPass123!', newPassword: 'PrivatePass456!' });
    const oldSession = await t.run(ctx => ctx.db.insert('authSessions', { userId, expirationTime: Date.now() + 60_000 }));
    await t.withIdentity({ subject: admin }).action(api.portalMembers.resetPortalAccountPassword, { email: 'temporary@example.com', password: 'ResetPass789!', role: 'admin' });
    expect(await t.run(ctx => ctx.db.get(memberId))).toMatchObject({ mustChangePassword: true });
    await expect(t.withIdentity({ subject: `${userId}|${oldSession}` }).query(api.portalMembers.current, {})).resolves.toBeNull();
    const sessionId = await t.run(ctx => ctx.db.insert('authSessions', { userId, expirationTime: Date.now() + 60_000 }));
    const resetActor = t.withIdentity({ subject: `${userId}|${sessionId}` });
    await expect(resetActor.query(api.workers.list, { includeEncodings: false })).rejects.toThrow('PASSWORD_CHANGE_REQUIRED');
    await resetActor.action(api.portalMembers.changePassword, { currentPassword: 'ResetPass789!', newPassword: 'PrivateAgain789!' });
    expect(await t.run(ctx => ctx.db.get(memberId))).toMatchObject({ mustChangePassword: false });
  });

  it.each(['short', 'lowercase123!', 'UPPERCASE123!', 'NoNumbers', 'TemporaryPass123!'])('rejects weak or unchanged new password %s', async newPassword => {
    const { actor, t, memberId } = await temporaryMember();
    await expect(actor.action(api.portalMembers.changePassword, { currentPassword: 'TemporaryPass123!', newPassword })).rejects.toThrow();
    expect(await t.run(ctx => ctx.db.get(memberId))).toMatchObject({ mustChangePassword: true });
  });

  it.each([
    ['TemporaryPass123!', 'TemporaryPass123！'],
    ['ＴemporaryPass123!', 'TemporaryPass123!'],
  ])('rejects password reuse after auth normalization (%s → %s)', async (currentPassword, newPassword) => {
    const { actor, t, memberId, accountId, sessionId } = await temporaryMember();
    const before = await t.run(ctx => ctx.db.get(accountId));
    await expect(actor.action(api.portalMembers.changePassword, { currentPassword, newPassword }))
      .rejects.toThrow('Choose a password different from your current password');
    expect(await t.run(ctx => ctx.db.get(memberId))).toMatchObject({ mustChangePassword: true });
    expect((await t.run(ctx => ctx.db.get(accountId)))?.secret).toBe(before?.secret);
    expect(await t.run(ctx => ctx.db.get(sessionId))).not.toBeNull();
  });

  it('rolls back credentials, flag, and session revocation when auditing fails', async () => {
    const { t, actor, memberId, accountId, sessionId } = await temporaryMember();
    const before = await t.run(ctx => ctx.db.get(accountId));
    const spy = vi.spyOn(audit, 'writeAuditLog').mockRejectedValueOnce(new Error('audit failed'));
    try {
      await expect(actor.action(api.portalMembers.changePassword, { currentPassword: 'TemporaryPass123!', newPassword: 'PrivatePass456!' })).rejects.toThrow('audit failed');
      expect(await t.run(ctx => ctx.db.get(memberId))).toMatchObject({ mustChangePassword: true });
      expect((await t.run(ctx => ctx.db.get(accountId)))?.secret).toBe(before?.secret);
      expect(await t.run(ctx => ctx.db.get(sessionId))).not.toBeNull();
    } finally { spy.mockRestore(); }
  });

  it('allows existing members without the flag and rejects disabled or anonymous password changes', async () => {
    const { t, admin, viewer, viewerMember } = await setup();
    await expect(t.withIdentity({ subject: viewer }).query(api.portalMembers.current, {})).resolves.toMatchObject({ mustChangePassword: false });
    await expect(t.withIdentity({ subject: viewer }).query(api.workers.list, { includeEncodings: false })).resolves.toEqual([]);
    const args = { currentPassword: 'TemporaryPass123!', newPassword: 'PrivatePass456!' };
    await expect(t.action(api.portalMembers.changePassword, args)).rejects.toThrow('Unauthorized');
    await t.withIdentity({ subject: admin }).mutation(api.portalMembers.setActive, { userId: viewer, active: false });
    await expect(t.withIdentity({ subject: viewer }).action(api.portalMembers.changePassword, args)).rejects.toThrow('Unauthorized');
    expect(await t.run(ctx => ctx.db.get(viewerMember))).toMatchObject({ active: false });
  });
});
