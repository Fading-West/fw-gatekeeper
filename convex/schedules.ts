import { query, mutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { assertPortalRole } from "./access";

import { isSupportedScheduleTimeRange, SCHEDULE_TIME_ERROR } from "./scheduleTimes";

function validateTimes(start: string, end: string) {
  if (!isSupportedScheduleTimeRange(start, end)) {
    throw new ConvexError({ code: "INVALID_SCHEDULE_TIMES", message: SCHEDULE_TIME_ERROR });
  }
}

const scheduleResult = v.object({
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
    name: v.string(),
    days: v.string(),
    startTime: v.string(),
    endTime: v.string(),
    department: v.optional(v.string()),
  },
  returns: v.object({ id: v.id("schedules") }),
  handler: async (ctx, args) => {
    await assertPortalRole(ctx, ["admin"]);

    validateTimes(args.startTime, args.endTime);
    const id = await ctx.db.insert("schedules", {
      name: args.name,
      days: args.days,
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
    validateTimes(fields.startTime ?? existing.startTime, fields.endTime ?? existing.endTime);
    const updates: Record<string, unknown> = {};
    if (fields.name !== undefined) updates.name = fields.name;
    if (fields.days !== undefined) updates.days = fields.days;
    if (fields.startTime !== undefined) updates.startTime = fields.startTime;
    if (fields.endTime !== undefined) updates.endTime = fields.endTime;
    if (fields.department !== undefined) updates.department = fields.department || undefined;
    await ctx.db.patch(id, updates);
    return { ok: true };
  },
});

export const remove = mutation({
  args: { id: v.id("schedules") },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args) => {
    await assertPortalRole(ctx, ["admin"]);

    await ctx.db.patch(args.id, { active: false });
    return { ok: true };
  },
});
