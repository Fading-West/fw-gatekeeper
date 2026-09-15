import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery } from "./_generated/server";

const MAX_ITEMS = 100;
const MAX_RESPONSE_BYTES = 256_000;
const AUDIT_SCAN_LIMIT_PER_ACTION = 500;
const HISTORY_WINDOW_DAYS = 30;
const ACTOR_ACTION_CHARACTER_LIMIT = 160;
const SUBJECT_CHARACTER_LIMIT = 240;
const ALLOWED_ACTIONS = new Map<string, string>([
  ["workers.updateIdentity", "updated worker record"],
  ["workers.remove", "deactivated worker"],
]);

export type ActivityFeedItem = {
  id: Id<"auditLog">;
  occurredAt: string;
  actor: string;
  action: string;
  subject: string;
  outcome: "succeeded";
  url: "/workers";
};

const activityFeedItemValidator = v.object({
  id: v.id("auditLog"),
  occurredAt: v.string(),
  actor: v.string(),
  action: v.string(),
  subject: v.string(),
  outcome: v.literal("succeeded"),
  url: v.literal("/workers"),
});

const activityFeedPayloadValidator = v.object({
  version: v.literal(1),
  asOf: v.string(),
  hasMore: v.boolean(),
  items: v.array(activityFeedItemValidator),
});

const activityFeedResultValidator = v.union(
  v.object({
    authorized: v.literal(false),
    reason: v.union(v.literal("mapping_missing"), v.literal("permission_denied")),
  }),
  v.object({ authorized: v.literal(true), payload: activityFeedPayloadValidator }),
  v.object({ authorized: v.literal(true), error: v.literal("scan_limit_exceeded") }),
);

function isValidTimestamp(value: string) {
  return Number.isFinite(Date.parse(value));
}

function limitCharacters(value: string, maximum: number) {
  return Array.from(value).slice(0, maximum).join("");
}

function recordedActorLabel(user: Doc<"users"> | null) {
  if (typeof user?.name === "string" && user.name.trim()) {
    return limitCharacters(user.name.trim(), ACTOR_ACTION_CHARACTER_LIMIT);
  }
  if (typeof user?.email === "string" && user.email.trim()) {
    return limitCharacters(user.email.trim(), ACTOR_ACTION_CHARACTER_LIMIT);
  }
  return "Actor not recorded";
}

/**
 * This query is intentionally internal. The only caller is the bearer-protected
 * Convex HTTP action. Authorization is repeated here at the database boundary
 * so a frontend route can never turn this into an unrestricted audit query.
 */
export const read = internalQuery({
  args: { sourceAccountId: v.string(), queriedAt: v.string() },
  returns: activityFeedResultValidator,
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
    const actionScans = await Promise.all(Array.from(ALLOWED_ACTIONS.keys()).map(async (action) => {
      const rows = await ctx.db
        .query("auditLog")
        .withIndex("by_target_table_and_action_and_created_at", (q) => q
          .eq("targetTable", "workers")
          .eq("action", action)
          .gte("createdAt", windowStart)
          .lte("createdAt", args.queriedAt))
        .order("desc")
        .take(AUDIT_SCAN_LIMIT_PER_ACTION + 1);
      const boundedRows = rows.slice(0, AUDIT_SCAN_LIMIT_PER_ACTION);
      const eligibleRows = boundedRows.filter((row) => isValidTimestamp(row.createdAt));
      return { eligibleRows, exhausted: rows.length > AUDIT_SCAN_LIMIT_PER_ACTION };
    }));

    // An exhausted stream with fewer than 101 eligible rows could hide an
    // event needed for either the page or hasMore. Never guess in that case.
    if (actionScans.some((scan) => scan.exhausted && scan.eligibleRows.length <= MAX_ITEMS)) {
      return { authorized: true as const, error: "scan_limit_exceeded" as const };
    }
    const auditRows = actionScans
      .flatMap((scan) => scan.eligibleRows)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right._creationTime - left._creationTime)
      .slice(0, MAX_ITEMS + 1);

    const actorLabels = new Map<Id<"users">, string>();
    const workerLabels = new Map<Id<"workers">, string>();
    const items: ActivityFeedItem[] = [];
    for (const row of auditRows) {
      const displayAction = ALLOWED_ACTIONS.get(row.action);
      if (!displayAction) continue;

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
        subject = worker?.name?.trim()
          ? limitCharacters(worker.name.trim(), SUBJECT_CHARACTER_LIMIT)
          : "Worker record";
        workerLabels.set(workerId, subject);
      }
      items.push({
        id: row._id,
        occurredAt: row.createdAt,
        actor,
        action: limitCharacters(displayAction, ACTOR_ACTION_CHARACTER_LIMIT),
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
