import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

export type AuditLogEntry = {
  actorUserId: Id<"users">;
  action: string;
  targetTable: string;
  targetId: string;
  reason?: string;
  details?: string;
};

/**
 * Append an immutable audit row. Every destructive or privacy-relevant
 * mutation (worker deactivation, biometric purge) must record who did it,
 * to what, when, and why. Rows are never edited or deleted.
 */
export async function writeAuditLog(ctx: MutationCtx, entry: AuditLogEntry) {
  return await ctx.db.insert("auditLog", {
    actorUserId: entry.actorUserId,
    action: entry.action,
    targetTable: entry.targetTable,
    targetId: entry.targetId,
    ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
    ...(entry.details !== undefined ? { details: entry.details } : {}),
    createdAt: new Date().toISOString(),
  });
}
