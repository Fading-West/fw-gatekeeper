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
  if (member?.sessionRevokedAt === undefined) return true;
  const separator = identity.subject.indexOf('|');
  // Once an account has been disabled, only a newly created live session
  // can authorize it after reactivation. Old JWTs outlive session deletion.
  if (separator < 0) return false;
  const session = await ctx.db.get(identity.subject.slice(separator + 1) as Id<"authSessions">);
  return session?.userId === userId
    && session.expirationTime > Date.now()
    && session._creationTime > member.sessionRevokedAt;
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
