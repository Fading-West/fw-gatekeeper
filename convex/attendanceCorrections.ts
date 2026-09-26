import { mutation, query } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { assertPortalRole } from "./access";
import { timestampBelongsToFactoryLocalDate } from "./localDate";
import { isValidAttendanceTimestamp } from "./attendanceValidation";

const nullableString = v.union(v.string(), v.null());

const attendanceCorrectionResult = v.object({
  id: v.string(),
  date: v.string(),
  worker_id: v.string(),
  worker_name: v.string(),
  worker_department: v.string(),
  action: v.union(v.literal("add_clock_in"), v.literal("add_clock_out"), v.literal("void_event")),
  event_type: v.union(v.literal("clock_in"), v.literal("clock_out"), v.null()),
  corrected_timestamp: nullableString,
  original_attendance_id: nullableString,
  original_timestamp: nullableString,
  original_event_type: nullableString,
  related_exception_key: nullableString,
  reason: v.string(),
  supervisor_name: nullableString,
  actor_user_id: nullableString,
  actor_name: nullableString,
  reversal_id: nullableString,
  reversal_reason: nullableString,
  reversed_by_user_id: nullableString,
  reversed_by_name: nullableString,
  reversed_at: nullableString,
  created_at: v.string(),
  updated_at: v.string(),
});

function normalizeText(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function getEventTypeForAction(action: "add_clock_in" | "add_clock_out" | "void_event") {
  if (action === "add_clock_in") return "clock_in";
  if (action === "add_clock_out") return "clock_out";
  return undefined;
}

export const list = query({
  args: {
    date: v.string(),
    workerId: v.optional(v.id("workers")),
  },
  returns: v.array(attendanceCorrectionResult),
  handler: async (ctx, args) => {
    await assertPortalRole(ctx, ["admin", "enrollment", "viewer"]);

    const baseQuery = args.workerId
      ? ctx.db
          .query("attendanceCorrections")
          .withIndex("by_worker_date", (q) => q.eq("workerId", args.workerId!).eq("date", args.date))
      : ctx.db
          .query("attendanceCorrections")
          .withIndex("by_date", (q) => q.eq("date", args.date));
    const corrections = await baseQuery.collect();
    corrections.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const rows = [];
    for (const correction of corrections) {
      const reversal = await ctx.db.query("attendanceCorrectionReversals")
        .withIndex("by_correctionId", (q) => q.eq("correctionId", correction._id)).unique();
      const actor = correction.actorUserId ? await ctx.db.get(correction.actorUserId) : null;
      const reversalActor = reversal ? await ctx.db.get(reversal.actorUserId) : null;
      const workerId = ctx.db.normalizeId("workers", correction.workerId);
      const worker = workerId ? await ctx.db.get(workerId) : null;
      const original = correction.originalAttendanceId
        ? await ctx.db.get(correction.originalAttendanceId).catch(() => null)
        : null;
      rows.push({
        id: String(correction._id),
        date: correction.date,
        worker_id: correction.workerId,
        worker_name: worker?.name || "",
        worker_department: worker?.department || "",
        action: correction.action,
        event_type: correction.eventType || getEventTypeForAction(correction.action) || null,
        corrected_timestamp: correction.correctedTimestamp || null,
        original_attendance_id: correction.originalAttendanceId ? String(correction.originalAttendanceId) : null,
        original_timestamp: original?.timestamp || null,
        original_event_type: original?.eventType || null,
        related_exception_key: correction.relatedExceptionKey || null,
        reason: correction.reason,
        supervisor_name: correction.supervisorName || null,
        actor_user_id: correction.actorUserId ? String(correction.actorUserId) : null,
        actor_name: actor?.name || actor?.email || null,
        reversal_id: reversal ? String(reversal._id) : null,
        reversal_reason: reversal?.reason || null,
        reversed_by_user_id: reversal ? String(reversal.actorUserId) : null,
        reversed_by_name: reversalActor?.name || reversalActor?.email || null,
        reversed_at: reversal?.createdAt || null,
        created_at: correction.createdAt,
        updated_at: correction.updatedAt,
      });
    }
    return rows;
  },
});

export const create = mutation({
  args: {
    requestId: v.optional(v.string()),
    date: v.string(),
    workerId: v.id("workers"),
    action: v.union(v.literal("add_clock_in"), v.literal("add_clock_out"), v.literal("void_event")),
    correctedTimestamp: v.optional(v.string()),
    originalAttendanceId: v.optional(v.id("attendance")),
    relatedExceptionKey: v.optional(v.string()),
    reason: v.string(),
    supervisorName: v.optional(v.string()),
  },
  returns: v.object({ id: v.id("attendanceCorrections"), createdAt: v.string() }),
  handler: async (ctx, args) => {
    const actor = await assertPortalRole(ctx, ["admin", "enrollment"]);

    const reason = normalizeText(args.reason);
    if (!reason) {
      throw new Error("Correction reason is required.");
    }

    const requestId = args.requestId;
    if (requestId !== undefined && (!requestId.trim() || requestId.length > 200)) {
      throw new Error("requestId must be a nonempty string of at most 200 characters.");
    }
    const correctedTimestamp = normalizeText(args.correctedTimestamp);
    const evidence = {
      date: args.date,
      workerId: args.workerId,
      action: args.action,
      correctedTimestamp: args.action === "void_event" ? undefined : correctedTimestamp,
      originalAttendanceId: args.originalAttendanceId,
      relatedExceptionKey: normalizeText(args.relatedExceptionKey),
      reason,
      supervisorName: normalizeText(args.supervisorName),
    };
    if (requestId !== undefined) {
      const existing = await ctx.db.query("attendanceCorrections")
        .withIndex("by_requestId", (q) => q.eq("requestId", requestId)).unique();
      if (existing) {
        if (Object.entries(evidence).some(([key, value]) => existing[key as keyof typeof evidence] !== value)) {
          throw new Error("Correction requestId was already used with different details.");
        }
        return { id: existing._id, createdAt: existing.createdAt };
      }
    }

    const worker = await ctx.db.get(args.workerId);
    if (!worker) {
      throw new Error("Worker not found.");
    }

    if (args.action === "void_event") {
      if (!args.originalAttendanceId) {
        throw new Error("originalAttendanceId is required when voiding an event.");
      }
      const original = await ctx.db.get(args.originalAttendanceId);
      if (!original) {
        throw new Error("Original attendance event not found.");
      }
      if (original.workerId !== args.workerId) {
        throw new Error("Original attendance event belongs to a different worker.");
      }
      if (!timestampBelongsToFactoryLocalDate(original.timestamp, args.date)) {
        throw new Error("Original attendance event is not on the correction date.");
      }
    } else if (!correctedTimestamp) {
      throw new Error("correctedTimestamp is required when adding an event.");
    } else if (!isValidAttendanceTimestamp(correctedTimestamp)) {
      throw new ConvexError({ code: "INVALID_CORRECTION_TIMESTAMP", message: "correctedTimestamp must be a valid ISO date and time, with optional UTC offset." });
    } else if (!timestampBelongsToFactoryLocalDate(correctedTimestamp, args.date)) {
      throw new ConvexError({ code: "INVALID_CORRECTION_TIMESTAMP", message: "correctedTimestamp must be on the correction date." });
    }

    const now = new Date().toISOString();
    const eventType = getEventTypeForAction(args.action);
    const id = await ctx.db.insert("attendanceCorrections", {
      ...evidence,
      requestId,
      eventType,
      actorUserId: actor.userId,
      createdAt: now,
      updatedAt: now,
    });

    return { id, createdAt: now };
  },
});

export const reverse = mutation({
  args: {
    correctionId: v.id("attendanceCorrections"),
    requestId: v.string(),
    reason: v.string(),
  },
  returns: v.object({ id: v.id("attendanceCorrectionReversals"), createdAt: v.string() }),
  handler: async (ctx, args) => {
    const actor = await assertPortalRole(ctx, ["admin", "enrollment"]);
    const reason = normalizeText(args.reason);
    if (!reason || reason.length > 1000) throw new ConvexError("Reversal reason must be 1 to 1,000 characters.");
    if (!args.requestId.trim() || args.requestId.length > 200) throw new ConvexError("requestId must be a nonempty string of at most 200 characters.");

    const existingRequest = await ctx.db.query("attendanceCorrectionReversals")
      .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId)).unique();
    if (existingRequest) {
      if (existingRequest.correctionId !== args.correctionId || existingRequest.reason !== reason) {
        throw new ConvexError("Reversal requestId was already used with different details.");
      }
      return { id: existingRequest._id, createdAt: existingRequest.createdAt };
    }
    const correction = await ctx.db.get(args.correctionId);
    if (!correction) throw new ConvexError("Correction not found.");
    const existingReversal = await ctx.db.query("attendanceCorrectionReversals")
      .withIndex("by_correctionId", (q) => q.eq("correctionId", args.correctionId)).unique();
    if (existingReversal) throw new ConvexError("Correction has already been reversed.");

    const createdAt = new Date().toISOString();
    const id = await ctx.db.insert("attendanceCorrectionReversals", {
      correctionId: correction._id,
      requestId: args.requestId,
      date: correction.date,
      workerId: correction.workerId,
      reason,
      actorUserId: actor.userId,
      createdAt,
    });
    return { id, createdAt };
  },
});
