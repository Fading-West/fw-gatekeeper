import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

export type PortalMemberRole = Doc<"portalMembers">["role"];

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

export async function assertPortalRole(
  ctx: QueryCtx | MutationCtx,
  allowedRoles: readonly PortalMemberRole[],
) {
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
  if (!allowedRoles.includes(member.role)) {
    throw new ConvexError("Insufficient permissions");
  }

  return member;
}
