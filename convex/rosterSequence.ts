import type { WithoutSystemFields } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

// The indexed singleton read also conflicts with its first insertion. Every
// roster write and receipt issuance touches this row, so OCC serializes them.
export async function readRosterSequence(ctx: QueryCtx) {
  return await ctx.db.query("rosterSequence")
    .withIndex("by_key", q => q.eq("key", "roster")).unique();
}

type WorkerFields = Omit<WithoutSystemFields<Doc<"workers">>, "rosterSequence">;

export function writeRosterWorker(ctx: MutationCtx, fields: WorkerFields): Promise<Id<"workers">>;
export function writeRosterWorker(ctx: MutationCtx, fields: Partial<WorkerFields>, id: Id<"workers">, purge?: boolean): Promise<Id<"workers">>;
export async function writeRosterWorker(ctx: MutationCtx, fields: Partial<WorkerFields>, id?: Id<"workers">, purge = false) {
  const counter = await readRosterSequence(ctx);
  const sequence = (counter?.value ?? 0) + 1;
  if (!Number.isSafeInteger(sequence)) throw new Error("Roster sequence exhausted");
  if (counter) {
    await ctx.db.patch(counter._id, { value: sequence, ...(purge ? { lastPurgeSequence: sequence } : {}) });
  } else {
    await ctx.db.insert("rosterSequence", { key: "roster", value: sequence, ...(purge ? { lastPurgeSequence: sequence } : {}) });
  }
  if (id) {
    await ctx.db.patch(id, { ...fields, rosterSequence: sequence });
    return id;
  }
  return await ctx.db.insert("workers", { ...fields as WorkerFields, rosterSequence: sequence });
}

// Only server-issued cursors have this prefix. Timestamps (including clocks
// ahead of Convex) always request a full roster, never a timestamp delta.
export function parseRosterCursor(since?: string) {
  if (!since || !/^seq:\d+$/.test(since)) return null;
  const sequence = Number(since.slice(4));
  return Number.isSafeInteger(sequence) ? sequence : null;
}
