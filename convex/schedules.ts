import { query, mutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { assertPortalRole } from "./access";

import { isSupportedScheduleTimeRange, SCHEDULE_TIME_ERROR } from "./scheduleTimes";
import { isValidScheduleName, parseScheduleDays, SCHEDULE_DAYS_ERROR, SCHEDULE_NAME_ERROR } from "./scheduleValidation";

function validateTimes(start: string, end: string) {
  if (!isSupportedScheduleTimeRange(start, end)) {
    throw new ConvexError({ code: "INVALID_SCHEDULE_TIMES", message: SCHEDULE_TIME_ERROR });
  }
}

function validateSchedule(name: string, days: string, start: string, end: string) {
  if (!isValidScheduleName(name)) throw new ConvexError({ code: "INVALID_SCHEDULE", message: SCHEDULE_NAME_ERROR });
  if (!parseScheduleDays(days)) throw new ConvexError({ code: "INVALID_SCHEDULE", message: SCHEDULE_DAYS_ERROR });
  validateTimes(start, end);
}

const scheduleResult = v.object({
  revision: v.number(),
  id: v.id("schedules"),
  name: v.string(),
  days: v.string(),
  start_time: v.string(),
  end_time: v.string(),
  department: v.union(v.string(), v.null()),
  active: v.number(),
  created_at: v.string(),
});

// Reads are open to every portal role (the Schedules page offers a
// review-only view); writes below stay admin-only.
export const list = query({
  args: {},
  returns: v.array(scheduleResult),
  handler: async (ctx) => {
    await assertPortalRole(ctx, ["admin", "enrollment", "viewer"]);

    const schedules = await ctx.db
      .query("schedules")
      .withIndex("by_active", (q) => q.eq("active", true))
      .collect();
    schedules.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return schedules.map((s) => ({
      revision: s.revision ?? 0,
      id: s._id,
      name: s.name,
      days: s.days,
      start_time: s.startTime,
      end_time: s.endTime,
      department: s.department || null,
      active: 1,
      created_at: s.createdAt,
    }));
  },
});

export const create = mutation({
  args: {
    requestId: v.optional(v.string()),
    expectedActorId: v.optional(v.id("users")),
    name: v.string(),
    days: v.string(),
    startTime: v.string(),
    endTime: v.string(),
    department: v.optional(v.string()),
  },
  returns: v.object({ id: v.id("schedules") }),
  handler: async (ctx, args) => {
    const actor = await assertPortalRole(ctx, ["admin"]);
    if (args.expectedActorId !== undefined && args.expectedActorId !== actor.userId) {
      throw new ConvexError({ code: "SCHEDULE_ACTOR_CONFLICT", message: "Your account changed. Reload schedules before creating a schedule." });
    }

    validateSchedule(args.name, args.days, args.startTime, args.endTime);
    if (args.requestId !== undefined && (!args.requestId.trim() || args.requestId.length > 200)) {
      throw new ConvexError({ code: "INVALID_SCHEDULE", message: "Schedule request ID must contain 1 to 200 characters." });
    }
    const creationIntent = JSON.stringify([args.name.trim(), [...parseScheduleDays(args.days)!].sort(), args.startTime, args.endTime, args.department?.trim() || ""]);
    if (args.requestId) {
      const existing = await ctx.db.query("schedules")
        .withIndex("by_creation_actor_and_request", q => q.eq("creationActorId", actor.userId).eq("creationRequestId", args.requestId))
        .unique();
      if (existing) {
        if (existing.creationIntent !== creationIntent) throw new ConvexError({ code: "SCHEDULE_REQUEST_CONFLICT", message: "This creation request was already used for a different schedule. Review the saved schedule before starting another." });
        return { id: existing._id };
      }
    }
    const id = await ctx.db.insert("schedules", {
      ...(args.requestId ? { creationRequestId: args.requestId, creationActorId: actor.userId, creationIntent } : {}),
      name: args.name.trim(),
      days: JSON.stringify(parseScheduleDays(args.days)),
      startTime: args.startTime,
      endTime: args.endTime,
      department: args.department,
      active: true,
      createdAt: new Date().toISOString(),
    });
    return { id };
  },
});

export const update = mutation({
  args: {
    expectedRevision: v.optional(v.number()),
    id: v.id("schedules"),
    name: v.optional(v.string()),
    days: v.optional(v.string()),
    startTime: v.optional(v.string()),
    endTime: v.optional(v.string()),
    department: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args) => {
    await assertPortalRole(ctx, ["admin"]);

    const { id, ...fields } = args;
    const existing = await ctx.db.get(id);
    if (!existing) throw new Error("Schedule not found");
    if (!existing.active) throw new ConvexError({ code: "SCHEDULE_REVISION_CONFLICT", message: "This schedule was removed. Reload the schedule list before continuing." });
    validateSchedule(fields.name ?? existing.name, fields.days ?? existing.days,
      fields.startTime ?? existing.startTime, fields.endTime ?? existing.endTime);
    const updates: Record<string, unknown> = {};
    if (fields.name !== undefined) updates.name = fields.name.trim();
    if (fields.days !== undefined) updates.days = JSON.stringify(parseScheduleDays(fields.days));
    if (fields.startTime !== undefined) updates.startTime = fields.startTime;
    if (fields.endTime !== undefined) updates.endTime = fields.endTime;
    if (fields.department !== undefined) updates.department = fields.department || undefined;
    if (Object.entries(updates).every(([field, value]) => existing[field as keyof typeof existing] === value)) return { ok: true };
    if (!Number.isSafeInteger(fields.expectedRevision) || fields.expectedRevision !== (existing.revision ?? 0)) {
      throw new ConvexError({ code: "SCHEDULE_REVISION_CONFLICT", message: "Schedule changed. Review the current schedule before saving your draft." });
    }
    updates.revision = (existing.revision ?? 0) + 1;
    await ctx.db.patch(id, updates);
    return { ok: true };
  },
});

export const remove = mutation({
  args: { id: v.id("schedules"), expectedRevision: v.optional(v.number()) },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args) => {
    await assertPortalRole(ctx, ["admin"]);

    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Schedule not found");
    if (!existing.active) return { ok: true };
    if (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision !== (existing.revision ?? 0)) {
      throw new ConvexError({ code: "SCHEDULE_REVISION_CONFLICT", message: "Schedule changed. Review the current schedule before removing it." });
    }
    await ctx.db.patch(args.id, { active: false, revision: (existing.revision ?? 0) + 1 });
    return { ok: true };
  },
});
