import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery } from "./_generated/server";

const MAX_ITEMS = 100;
const MAX_RESPONSE_BYTES = 256 * 1024;
const HISTORY_WINDOW_DAYS = 30;
const ALLOWED_ACTIONS = new Map<string, string>([
  ["workers.updateIdentity", "updated worker record"],
  ["workers.remove", "deactivated worker"],
]);

export type ActivityFeedItem = {
  id: string;
  occurredAt: string;
  actor: string;
  action: string;
  subject: string;
  outcome: "succeeded";
  url: string;
};

function isValidTimestamp(value: string) {
  return Number.isFinite(Date.parse(value));
}

function recordedActorLabel(user: Doc<"users"> | null) {
  if (typeof user?.name === "string" && user.name.trim()) return user.name.trim();
  if (typeof user?.email === "string" && user.email.trim()) return user.email.trim();
  return "Actor not recorded";
}

/**
 * This query is intentionally internal. The only caller is the bearer-protected
 * Convex HTTP action. Authorization is repeated here at the database boundary
 * so a frontend route can never turn this into an unrestricted audit query.
 */
export const read = internalQuery({
  args: { sourceAccountId: v.string(), queriedAt: v.string() },
  handler: async (ctx, args) => {
    const sourceAccountId = ctx.db.normalizeId("users", args.sourceAccountId);
    if (!sourceAccountId || !isValidTimestamp(args.queriedAt)) {
      return { authorized: false as const, reason: "mapping_missing" as const };
    }

    const [sourceAccount, sourceMember] = await Promise.all([
      ctx.db.get(sourceAccountId),
      ctx.db
        .query("portalMembers")
        .withIndex("by_user", (q) => q.eq("userId", sourceAccountId))
        .unique(),
    ]);
    if (!sourceAccount || !sourceMember) {
      return { authorized: false as const, reason: "mapping_missing" as const };
    }
    if (!sourceMember.active || sourceMember.role !== "admin") {
      return { authorized: false as const, reason: "permission_denied" as const };
    }

    const queriedAtMs = Date.parse(args.queriedAt);
    const windowStart = new Date(queriedAtMs - HISTORY_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const auditRows = await ctx.db
      .query("auditLog")
      .withIndex("by_created", (q) => q.gte("createdAt", windowStart))
      .order("desc")
      .collect();

    const actorLabels = new Map<Id<"users">, string>();
    const workerLabels = new Map<Id<"workers">, string>();
    const items: ActivityFeedItem[] = [];
    for (const row of auditRows) {
      const displayAction = ALLOWED_ACTIONS.get(row.action);
      if (
        !displayAction ||
        row.targetTable !== "workers" ||
        !isValidTimestamp(row.createdAt) ||
        Date.parse(row.createdAt) > queriedAtMs
      ) continue;

      let actor = actorLabels.get(row.actorUserId);
      if (!actor) {
        actor = recordedActorLabel(await ctx.db.get(row.actorUserId));
        actorLabels.set(row.actorUserId, actor);
      }

      // Worker labels are resolved only after the mapped source account has
      // passed the admin check above. Reasons, details, HR fields, and biometric
      // fields are never copied into the response.
      const workerId = ctx.db.normalizeId("workers", row.targetId);
      let subject = workerId ? workerLabels.get(workerId) : undefined;
      if (!subject && workerId) {
        const worker = await ctx.db.get(workerId);
        subject = worker?.name?.trim() || "Worker record";
        workerLabels.set(workerId, subject);
      }
      items.push({
        id: row._id,
        occurredAt: row.createdAt,
        actor,
        action: displayAction,
        subject: subject || "Worker record",
        outcome: "succeeded",
        url: "/workers",
      });
    }

    const payload = {
      version: 1 as const,
      asOf: args.queriedAt,
      hasMore: items.length > MAX_ITEMS,
      items: items.slice(0, MAX_ITEMS),
    };
    while (new TextEncoder().encode(JSON.stringify(payload)).byteLength > MAX_RESPONSE_BYTES && payload.items.length > 0) {
      payload.items.pop();
      payload.hasMore = true;
    }

    return { authorized: true as const, payload };
  },
});
