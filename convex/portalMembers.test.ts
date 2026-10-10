/// <reference types="vite/client" />

import { createHash, generateKeyPairSync } from 'node:crypto';
import { convexTest } from 'convex-test';
import { Scrypt } from 'lucia';
import { describe, expect, it, vi } from 'vitest';

import { api, internal } from './_generated/api';
import schema from './schema';
import * as audit from './audit';

const modules = import.meta.glob('./**/*.ts');

// Password tests are the slowest in the suite: @convex-dev/auth hashes and
// verifies with Lucia's pure-JS Scrypt (N=16384, r=16), roughly 250-370 ms per
// call on a loaded host, and sign-in also signs a JWT. Give them generous
// explicit timeouts so CPU contention cannot trip vitest's 5 s default.
const PASSWORD_TEST_TIMEOUT_MS = 30_000;

// Generating a 2048-bit RSA key is slow and nondeterministic in duration, so
// generate it once per file. Each withLocalAuthKeys call still stubs and
// restores the env vars, so no test sees another test's auth environment.
let localAuthPrivateKey: string | undefined;
function getLocalAuthPrivateKey() {
  localAuthPrivateKey ??= generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  return localAuthPrivateKey;
}

async function withLocalAuthKeys(run: () => Promise<void>) {
  vi.stubEnv('JWT_PRIVATE_KEY', getLocalAuthPrivateKey());
  vi.stubEnv('CONVEX_SITE_URL', 'https://example.convex.site');
  try {
    await run();
  } finally {
    vi.unstubAllEnvs();
  }
}

// Replaces the Password provider's Scrypt with a fast deterministic hash for
// the current test only. Use it ONLY in tests that write a credential but never
// sign in or otherwise verify one. Tests that sign in keep real Scrypt so they
// exercise the provider's real hash and verify end to end. The fake still
// preserves the semantics those tests rely on: the stored secret is never the
// plaintext, distinct passwords produce distinct secrets, and verify rejects a
// wrong password. 'lucia' resolves to the same copy that @convex-dev/auth
// imports, so the prototype spy intercepts the provider's calls; each caller
// asserts that the fake hash ran.
function useFastPasswordHashing(onTestFinished: (cleanup: () => void) => void) {
  const fakeHash = (password: string) =>
    `test-sha256:${createHash('sha256').update(password.normalize('NFKC')).digest('hex')}`;
  const hash = vi.spyOn(Scrypt.prototype, 'hash').mockImplementation(async (password: string) => fakeHash(password));
  const verify = vi.spyOn(Scrypt.prototype, 'verify')
    .mockImplementation(async (stored: string, password: string) => stored === fakeHash(password));
  onTestFinished(() => {
    hash.mockRestore();
    verify.mockRestore();
  });
  return { hash, verify };
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

describe('portal member lifecycle', { timeout: PASSWORD_TEST_TIMEOUT_MS }, () => {
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

it('rolls back the password write if the audit step fails in the same mutation', { timeout: PASSWORD_TEST_TIMEOUT_MS }, async ({ onTestFinished }) => {
  const fastHashing = useFastPasswordHashing(onTestFinished); // Writes a credential but never verifies it.
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
    expect(fastHashing.hash).toHaveBeenCalledOnce();
  } finally {
    spy.mockRestore();
  }
});

it('resets a password with an audit and immediate session cutoff, while rejecting a nonadmin', { timeout: PASSWORD_TEST_TIMEOUT_MS }, async ({ onTestFinished }) => {
  const fastHashing = useFastPasswordHashing(onTestFinished); // Writes a credential but never verifies it.
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
  expect(fastHashing.hash).toHaveBeenCalledOnce();
  expect(state.member?.sessionRevokedAt).toBeGreaterThanOrEqual(startedAt);
  expect(state.audit).toMatchObject([{ actorUserId: admin, action: 'portalMembers.resetPassword' }]);
  expect(await t.run(ctx => ctx.db.get(viewerSession))).toBeNull();
  expect(await t.withIdentity({ subject: `${viewer}|${viewerSession}` }).query(api.portalMembers.current, {})).toBeNull();
});

it('creates the password account, member, and audit in one mutation', { timeout: PASSWORD_TEST_TIMEOUT_MS }, async () => {
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

it('signs in with a reset password and rejects the previous password', { timeout: PASSWORD_TEST_TIMEOUT_MS }, async () => {
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

it('rolls back account and user creation if the member audit fails', { timeout: PASSWORD_TEST_TIMEOUT_MS }, async ({ onTestFinished }) => {
  const fastHashing = useFastPasswordHashing(onTestFinished); // Writes a credential but never verifies it.
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
    expect(fastHashing.hash).toHaveBeenCalledOnce();
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
