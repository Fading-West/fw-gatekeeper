import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";

import type { Doc } from "./_generated/dataModel";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

export type PortalMemberRole = Doc<"portalMembers">["role"];

const SESSION_CLEANUP_BATCH = 100;

// Time alone does not invalidate cached/subscribed Convex queries. Deleting
// the expired session changes the document every authorized query reads.
export const expireSessions = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const expired = await ctx.db.query("authSessions")
      .withIndex("by_expirationTime", (q) => q.lte("expirationTime", Date.now()))
      .take(SESSION_CLEANUP_BATCH);
    for (const session of expired) {
      await ctx.db.delete(session._id);
      await ctx.scheduler.runAfter(0, internal.access.removeExpiredSessionTokens, { sessionId: session._id });
    }
    if (expired.length === SESSION_CLEANUP_BATCH) {
      await ctx.scheduler.runAfter(0, internal.access.expireSessions, {});
    }
    return expired.length;
  },
});

export const removeExpiredSessionTokens = internalMutation({
  args: { sessionId: v.id("authSessions") },
  returns: v.number(),
  handler: async (ctx, { sessionId }) => {
    // Never remove tokens for a session that is still present.
    if (await ctx.db.get(sessionId)) return 0;
    const tokens = await ctx.db.query("authRefreshTokens")
      .withIndex("sessionId", (q) => q.eq("sessionId", sessionId))
      .take(SESSION_CLEANUP_BATCH);
    for (const token of tokens) await ctx.db.delete(token._id);
    if (tokens.length === SESSION_CLEANUP_BATCH) {
      await ctx.scheduler.runAfter(0, internal.access.removeExpiredSessionTokens, { sessionId });
    }
    return tokens.length;
  },
});

export async function hasCurrentPortalSession(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity || identity.subject.split('|', 1)[0] !== userId) return false;
  const member = await ctx.db.query('portalMembers')
    .withIndex('by_user', (q) => q.eq('userId', userId)).unique();
  const separator = identity.subject.indexOf('|');
  // Preserve bare-user identities only for accounts without a revocation cutoff.
  // Convex Auth JWTs include a session ID: always validate that session, even
  // before the account's first disable/reset. Sign-out deletes the session but
  // an already-issued JWT can remain cryptographically valid until it expires.
  if (separator < 0) return member?.sessionRevokedAt === undefined;
  const sessionId = ctx.db.normalizeId('authSessions', identity.subject.slice(separator + 1));
  if (!sessionId) return false;
  const session = await ctx.db.get(sessionId);
  return session?.userId === userId
    && session.expirationTime > Date.now()
    && (member?.sessionRevokedAt === undefined || session._creationTime > member.sessionRevokedAt);
}

// Only current-member lookup and self-service password rotation may use this
// identity check without also enforcing mustChangePassword.
export async function assertPortalMember(ctx: QueryCtx | MutationCtx) {
  const userId = await getAuthUserId(ctx);
  if (!userId) {
    throw new ConvexError("Unauthorized");
  }
  if (!(await hasCurrentPortalSession(ctx, userId))) {
    throw new ConvexError("Unauthorized");
  }

  const member = await ctx.db
    .query("portalMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();

  if (!member?.active) {
    throw new ConvexError("Unauthorized");
  }
  return member;
}

export function assertPasswordChanged(member: Doc<"portalMembers">) {
  if (member.mustChangePassword === true) {
    throw new ConvexError("PASSWORD_CHANGE_REQUIRED");
  }
}

export async function assertPortalRole(
  ctx: QueryCtx | MutationCtx,
  allowedRoles: readonly PortalMemberRole[],
) {
  const member = await assertPortalMember(ctx);
  assertPasswordChanged(member);
  if (!allowedRoles.includes(member.role)) {
    throw new ConvexError("Insufficient permissions");
  }

  return member;
}
