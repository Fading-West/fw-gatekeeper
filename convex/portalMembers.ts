import { getAuthUserId } from '@convex-dev/auth/server';
import { ConvexError, v } from 'convex/values';
import { Scrypt } from 'lucia';

import { action, internalMutation, internalQuery, mutation, query } from './_generated/server';
import { internal } from './_generated/api';
import { assertPortalRole, assertPortalMember, assertPasswordChanged, hasCurrentPortalSession } from './access';
import { writeAuditLog } from './audit';
import type { Doc } from './_generated/dataModel';
import type { ActionCtx, MutationCtx, QueryCtx } from './_generated/server';

const portalMemberRole = v.union(v.literal('admin'), v.literal('enrollment'), v.literal('viewer'));
const currentMemberValidator = v.object({
  userId: v.id('users'), role: portalMemberRole, active: v.boolean(), mustChangePassword: v.boolean(),
});
type PortalMemberRole = Doc<'portalMembers'>['role'];

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function assertValidPassword(password: string) {
  if (password.length < 8) {
    throw new ConvexError('Password must be at least 8 characters long');
  }
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>/?`~]/.test(password)) {
    throw new ConvexError('Password must include uppercase, lowercase, and a number or symbol');
  }
}

export const current = query({
  args: {},
  returns: v.union(v.null(), currentMemberValidator),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return null;
    }

    const member = await ctx.db
      .query('portalMembers')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .unique();

    if (!member?.active || !(await hasCurrentPortalSession(ctx, userId))) {
      return null;
    }

    return {
      userId: member.userId,
      role: member.role,
      active: member.active,
      mustChangePassword: member.mustChangePassword === true,
    };
  },
});

export const list = query({
  args: {},
  returns: v.array(v.object({
    id: v.id('portalMembers'), userId: v.id('users'), email: v.string(),
    role: portalMemberRole, active: v.boolean(), createdAt: v.string(), updatedAt: v.optional(v.string()),
  })),
  handler: async (ctx) => {
    await assertPortalRole(ctx, ['admin']);

    const members = await ctx.db.query('portalMembers').collect();
    const rows = [];
    for (const member of members) {
      const user = await ctx.db.get(member.userId);
      rows.push({
        id: member._id,
        userId: member.userId,
        email: typeof user?.email === 'string' ? user.email : 'Unknown email',
        role: member.role,
        active: member.active,
        createdAt: member.createdAt,
        updatedAt: member.updatedAt,
      });
    }

    return rows.sort((a, b) => a.email.localeCompare(b.email));
  },
});

export const getActiveMemberByUserId = internalQuery({
  args: { userId: v.id('users') },
  returns: v.union(v.null(), currentMemberValidator),
  handler: async (ctx, args) => {
    const member = await ctx.db
      .query('portalMembers')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .unique();

    if (!member?.active || !(await hasCurrentPortalSession(ctx, args.userId))) {
      return null;
    }

    assertPasswordChanged(member);

    return {
      userId: member.userId,
      role: member.role,
      active: member.active,
      mustChangePassword: member.mustChangePassword === true,
    };
  },
});

export const getPasswordAccountByEmail = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const account = await ctx.db
      .query('authAccounts')
      .withIndex('providerAndAccountId', (q) => q.eq('provider', 'password').eq('providerAccountId', args.email))
      .first();

    return account ? { userId: account.userId } : null;
  },
});

export const createAccountAndMember = internalMutation({
  args: {
    email: v.string(),
    password: v.string(),
    role: portalMemberRole,
  },
  returns: v.object({ email: v.string(), role: portalMemberRole, active: v.boolean() }),
  handler: async (ctx, args) => {
    const actor = await assertPortalRole(ctx, ['admin']);
    const email = normalizeEmail(args.email);
    if (!email || !email.includes('@')) {
      throw new ConvexError('A valid email address is required');
    }
    assertValidPassword(args.password);
    const now = new Date().toISOString();
    const existing = await ctx.db
      .query('authAccounts')
      .withIndex('providerAndAccountId', (q) => q.eq('provider', 'password').eq('providerAccountId', email))
      .unique();
    if (existing) {
      throw new ConvexError('An account with this email already exists. Use Reset Password instead.');
    }

    // This nested auth store call shares the mutation transaction. If member
    // creation or its audit fails, Convex rolls back the auth account too.
    const created = await ctx.runMutation(internal.auth.store, { args: {
      type: 'createAccountFromCredentials',
      provider: 'password',
      account: { id: email, secret: args.password },
      profile: { email },
    } });
    if (!created || typeof created !== 'object' || !('user' in created)) {
      throw new ConvexError('Password account creation failed');
    }

    const memberId = await ctx.db.insert('portalMembers', {
      userId: created.user._id,
      role: args.role,
      active: true,
      mustChangePassword: true,
      createdAt: now,
      updatedAt: now,
    });
    await writeAuditLog(ctx, { actorUserId: actor.userId, action: 'portalMembers.create', targetTable: 'portalMembers', targetId: memberId, details: JSON.stringify({ role: args.role }) });
    await ctx.db.insert('peopleAlertEvents', {
      kind: 'portal_account',
      targetId: memberId,
      label: email,
      detail: args.role,
      createdAt: now,
      delivered: false,
    });
    await ctx.scheduler.runAfter(0, internal.peopleAlerts.deliverPending, {});
    return { email, role: args.role, active: true };
  },
});

async function requireTarget(ctx: MutationCtx, userId: Doc<'portalMembers'>['userId']) {
  const actor = await assertPortalRole(ctx, ['admin']);
  const target = await ctx.db.query('portalMembers')
    .withIndex('by_user', (q) => q.eq('userId', userId)).unique();
  if (!target) throw new ConvexError('Portal account not found');
  return { actor, target };
}

async function protectLastAdmin(ctx: MutationCtx, target: Doc<'portalMembers'>, nextRole: PortalMemberRole, nextActive: boolean) {
  if (!target.active || target.role !== 'admin' || (nextActive && nextRole === 'admin')) return;
  // The index range read participates in Convex OCC, so concurrent demotions
  // or disables cannot both commit after observing each other as an admin.
  const admins = await ctx.db.query('portalMembers')
    .withIndex('by_active_and_role', (q) => q.eq('active', true).eq('role', 'admin'))
    .take(2);
  if (!admins.some((admin) => admin._id !== target._id)) {
    throw new ConvexError('Cannot remove the last active administrator');
  }
}

async function revokeSessionBatch(ctx: MutationCtx, userId: Doc<'portalMembers'>['userId'], cutoff: number) {
  const maxSessions = 10;
  let tokenBudget = 100;
  const sessions = await ctx.db.query('authSessions')
    .withIndex('userId', (q) => q.eq('userId', userId)).take(maxSessions);
  for (const session of sessions) {
    if (session._creationTime > cutoff) break;
    // Read one past the remaining budget to know whether this session still
    // owns tokens. Never delete more than 100 refresh tokens per transaction.
    const tokens = await ctx.db.query('authRefreshTokens')
      .withIndex('sessionId', (q) => q.eq('sessionId', session._id)).take(tokenBudget + 1);
    for (const token of tokens.slice(0, tokenBudget)) await ctx.db.delete(token._id);
    const incomplete = tokens.length > tokenBudget;
    tokenBudget -= Math.min(tokens.length, tokenBudget);
    if (incomplete) break;
    await ctx.db.delete(session._id);
  }
  const next = (await ctx.db.query('authSessions')
    .withIndex('userId', (q) => q.eq('userId', userId)).take(1))[0];
  if (next && next._creationTime <= cutoff) {
    await ctx.scheduler.runAfter(0, internal.portalMembers.cleanupRevokedSessions, { userId, cutoff });
  }
}

export const cleanupRevokedSessions = internalMutation({
  args: { userId: v.id('users'), cutoff: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await revokeSessionBatch(ctx, args.userId, args.cutoff);
    return null;
  },
});

export const setRole = mutation({
  args: { userId: v.id('users'), role: portalMemberRole },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { actor, target } = await requireTarget(ctx, args.userId);
    if (target.role === args.role) return null;
    await protectLastAdmin(ctx, target, args.role, target.active);
    await ctx.db.patch(target._id, { role: args.role, updatedAt: new Date().toISOString() });
    await writeAuditLog(ctx, { actorUserId: actor.userId, action: 'portalMembers.setRole', targetTable: 'portalMembers', targetId: target._id, details: JSON.stringify({ from: target.role, to: args.role }) });
    return null;
  },
});

export const setActive = mutation({
  args: { userId: v.id('users'), active: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { actor, target } = await requireTarget(ctx, args.userId);
    if (target.active === args.active) return null;
    await protectLastAdmin(ctx, target, target.role, args.active);
    const now = new Date();
    // Convex creation times may have sub-millisecond precision. Include the
    // latest committed session rather than truncating the cutoff to an ISO date.
    const latestSession = !args.active ? await ctx.db.query('authSessions')
      .withIndex('userId', q => q.eq('userId', args.userId)).order('desc').first() : null;
    const cutoff = Math.max(now.getTime(), latestSession?._creationTime ?? 0);
    await ctx.db.patch(target._id, {
      active: args.active,
      updatedAt: now.toISOString(),
      ...(!args.active ? { sessionRevokedAt: cutoff } : {}),
    });
    if (!args.active) await revokeSessionBatch(ctx, args.userId, cutoff);
    await writeAuditLog(ctx, { actorUserId: actor.userId, action: args.active ? 'portalMembers.reactivate' : 'portalMembers.disable', targetTable: 'portalMembers', targetId: target._id });
    return null;
  },
});

export const resetAccountPassword = internalMutation({
  args: { email: v.string(), password: v.string(), role: portalMemberRole },
  returns: v.object({ active: v.boolean(), role: portalMemberRole }),
  handler: async (ctx, args) => {
    const actor = await assertPortalRole(ctx, ['admin']);
    assertValidPassword(args.password);
    const account = await ctx.db.query('authAccounts')
      .withIndex('providerAndAccountId', q => q.eq('provider', 'password').eq('providerAccountId', args.email))
      .unique();
    if (!account) throw new ConvexError('No existing password account was found for this email. Create the account first.');
    const target = await ctx.db.query('portalMembers')
      .withIndex('by_user', q => q.eq('userId', account.userId)).unique();
    if (!target) throw new ConvexError('Portal account not found');
    await protectLastAdmin(ctx, target, args.role, target.active);
    if (target.role !== args.role) {
      throw new ConvexError('Change the account role separately before resetting its password');
    }
    await ctx.runMutation(internal.auth.store, { args: {
      type: 'modifyAccount', provider: 'password', account: { id: args.email, secret: args.password },
    } });
    const latestSession = await ctx.db.query('authSessions')
      .withIndex('userId', q => q.eq('userId', account.userId)).order('desc').first();
    const cutoff = Math.max(Date.now(), latestSession?._creationTime ?? 0, target.sessionRevokedAt ?? 0);
    await ctx.db.patch(target._id, { mustChangePassword: true, sessionRevokedAt: cutoff, updatedAt: new Date().toISOString() });
    await revokeSessionBatch(ctx, account.userId, cutoff);
    await writeAuditLog(ctx, { actorUserId: actor.userId, action: 'portalMembers.resetPassword', targetTable: 'portalMembers', targetId: target._id });
    return { active: target.active, role: target.role };
  },
});

async function assertAdminUser(ctx: ActionCtx) {
  const adminUserId = await getAuthUserId(ctx);
  if (!adminUserId) {
    throw new ConvexError('Unauthorized');
  }

  const adminMember = await ctx.runQuery(internal.portalMembers.getActiveMemberByUserId, {
    userId: adminUserId,
  });

  if (adminMember?.role !== 'admin') {
    throw new ConvexError('Admin access required');
  }
}

export const createPortalAccount = action({
  args: {
    email: v.string(),
    password: v.string(),
    role: portalMemberRole,
  },
  returns: v.object({ email: v.string(), role: portalMemberRole, active: v.boolean() }),
  handler: async (ctx, args): Promise<{ email: string; role: PortalMemberRole; active: boolean }> => {
    await assertAdminUser(ctx);

    const email = normalizeEmail(args.email);
    if (!email || !email.includes('@')) {
      throw new ConvexError('A valid email address is required');
    }
    assertValidPassword(args.password);

    return await ctx.runMutation(internal.portalMembers.createAccountAndMember, {
      email, password: args.password, role: args.role,
    });
  },
});

export const resetPortalAccountPassword = action({
  args: {
    email: v.string(),
    password: v.string(),
    role: portalMemberRole,
  },
  returns: v.object({ email: v.string(), role: portalMemberRole, active: v.boolean() }),
  handler: async (ctx, args): Promise<{ email: string; role: PortalMemberRole; active: boolean }> => {
    await assertAdminUser(ctx);

    const email = normalizeEmail(args.email);
    if (!email || !email.includes('@')) {
      throw new ConvexError('A valid email address is required');
    }
    assertValidPassword(args.password);

    const member = await ctx.runMutation(internal.portalMembers.resetAccountPassword, {
      email, password: args.password, role: args.role,
    });

    return { email, role: member.role, active: member.active };
  },
});

// Self-service password change.
//
// In @convex-dev/auth 0.0.95, signIn is an action whose Password provider calls
// retrieveAccount/modifyAccountCredentials. Those helpers are thin action-side
// wrappers around the auth:store mutation, and the scrypt verify or hash runs
// inside that mutation: one scrypt operation per transaction. A password change
// needs two verifies and one hash, which can exceed Convex's 1 s mutation limit
// on a slow host. Members with mustChangePassword would then be locked out.
//
// This flow therefore runs all scrypt work in the public action. The internal
// mutations below only read, compare and write rows. They never receive a
// plaintext password. The final mutation is the single atomic write, and it
// aborts if the credential or flag changed after the action read them.

// The @convex-dev/auth default; convex/auth.ts does not override
// signIn.maxFailedAttempsPerHour. The bucket row and refill formula are the
// library's, so sign-in and password change share one failed-attempt budget.
const MAX_FAILED_PASSWORD_ATTEMPTS_PER_HOUR = 10;

const ownPasswordAccountValidator = v.object({
  accountId: v.id('authAccounts'),
  storedHash: v.string(),
  mustChangePassword: v.boolean(),
});
type OwnPasswordAccount = typeof ownPasswordAccountValidator.type;

async function readOwnPasswordAccount(ctx: QueryCtx | MutationCtx) {
  const member = await assertPortalMember(ctx);
  const account = await ctx.db.query('authAccounts')
    .withIndex('userIdAndProvider', q => q.eq('userId', member.userId).eq('provider', 'password')).unique();
  if (!account?.secret) throw new ConvexError('Password account not found');
  return { member, account, secret: account.secret };
}

// Optimistic concurrency check. The action verified passwords against
// `expected.storedHash`. If an admin reset, another password change, or a flag
// change committed since then, that verification is stale. Abort and let the
// member retry from a fresh read.
async function assertOwnPasswordAccountUnchanged(ctx: MutationCtx, expected: OwnPasswordAccount) {
  const { member, account, secret } = await readOwnPasswordAccount(ctx);
  if (account._id !== expected.accountId || secret !== expected.storedHash
    || (member.mustChangePassword === true) !== expected.mustChangePassword) {
    throw new ConvexError('PASSWORD_CHANGE_CONFLICT');
  }
  return { member, account };
}

export const getOwnPasswordAccount = internalQuery({
  args: {},
  returns: ownPasswordAccountValidator,
  handler: async (ctx): Promise<OwnPasswordAccount> => {
    const { member, account, secret } = await readOwnPasswordAccount(ctx);
    return { accountId: account._id, storedHash: secret, mustChangePassword: member.mustChangePassword === true };
  },
});

// Consume one failed-attempt token before the action verifies the current
// password. The library records the failure after its in-mutation verify. With
// the verify now in the action, recording afterwards would let concurrent
// guesses all pass the limit check before any failure is recorded. Reserving
// first lets Convex OCC serialize concurrent reservations on the bucket row (or
// on its empty index range). At most the remaining budget of verifies can be
// in flight. A wrong guess or a crashed action keeps the token consumed. Only a
// verified current password resets the bucket, as the library does.
export const reserveCurrentPasswordAttempt = internalMutation({
  args: ownPasswordAccountValidator,
  returns: v.null(),
  handler: async (ctx, args) => {
    const { account } = await assertOwnPasswordAccountUnchanged(ctx, args);
    const limit = await ctx.db.query('authRateLimits')
      .withIndex('identifier', q => q.eq('identifier', account._id)).unique();
    const now = Date.now();
    const attemptsLeft = limit
      ? Math.min(MAX_FAILED_PASSWORD_ATTEMPTS_PER_HOUR, limit.attemptsLeft
        + (now - limit.lastAttemptTime) * MAX_FAILED_PASSWORD_ATTEMPTS_PER_HOUR / 3_600_000)
      : MAX_FAILED_PASSWORD_ATTEMPTS_PER_HOUR;
    if (attemptsLeft < 1) throw new ConvexError('TOO_MANY_ATTEMPTS');
    if (limit) await ctx.db.patch(limit._id, { attemptsLeft: attemptsLeft - 1, lastAttemptTime: now });
    else await ctx.db.insert('authRateLimits', { identifier: account._id, attemptsLeft: attemptsLeft - 1, lastAttemptTime: now });
    return null;
  },
});

export const recordCurrentPasswordVerified = internalMutation({
  args: ownPasswordAccountValidator,
  returns: v.null(),
  handler: async (ctx, args) => {
    // The hash must still match. Otherwise a password known only before an
    // intervening reset could clear the failed-attempt budget.
    const { account } = await assertOwnPasswordAccountUnchanged(ctx, args);
    const limit = await ctx.db.query('authRateLimits')
      .withIndex('identifier', q => q.eq('identifier', account._id)).unique();
    if (limit) await ctx.db.delete(limit._id);
    return null;
  },
});

export const completePasswordChange = internalMutation({
  args: { ...ownPasswordAccountValidator.fields, newHash: v.string() },
  returns: v.null(),
  handler: async (ctx, { newHash, ...expected }) => {
    const { member, account } = await assertOwnPasswordAccountUnchanged(ctx, expected);
    await ctx.db.patch(account._id, { secret: newHash });
    const latestSession = await ctx.db.query('authSessions')
      .withIndex('userId', q => q.eq('userId', member.userId)).order('desc').first();
    const cutoff = Math.max(Date.now(), latestSession?._creationTime ?? 0, member.sessionRevokedAt ?? 0);
    // Session deletion alone cannot revoke already-issued JWTs. The cutoff
    // denies every old JWT immediately, including the caller's, and the bounded
    // batch (with scheduled continuation) deletes the session rows.
    await ctx.db.patch(member._id, {
      mustChangePassword: false, sessionRevokedAt: cutoff, updatedAt: new Date().toISOString(),
    });
    await revokeSessionBatch(ctx, member.userId, cutoff);
    await writeAuditLog(ctx, {
      actorUserId: member.userId, action: 'portalMembers.changePassword',
      targetTable: 'portalMembers', targetId: member._id,
    });
    return null;
  },
});

export const changePassword = action({
  args: { currentPassword: v.string(), newPassword: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const snapshot: OwnPasswordAccount = await ctx.runQuery(internal.portalMembers.getOwnPasswordAccount, {});
    assertValidPassword(args.newPassword);
    await ctx.runMutation(internal.portalMembers.reserveCurrentPasswordAttempt, snapshot);
    // The same helpers as the configured Password provider's default crypto
    // (Lucia Scrypt), so NFKC normalization and UTF-8 handling match sign-in.
    const scrypt = new Scrypt();
    if (!(await scrypt.verify(snapshot.storedHash, args.currentPassword))) {
      throw new ConvexError('INVALID_CURRENT_PASSWORD');
    }
    await ctx.runMutation(internal.portalMembers.recordCurrentPasswordVerified, snapshot);
    // Reuse is checked against the stored hash, so no plaintext temporary
    // password is ever retained.
    if (await scrypt.verify(snapshot.storedHash, args.newPassword)) {
      throw new ConvexError('Choose a password different from your current password');
    }
    const newHash = await scrypt.hash(args.newPassword);
    await ctx.runMutation(internal.portalMembers.completePasswordChange, { ...snapshot, newHash });
    return null;
  },
});
