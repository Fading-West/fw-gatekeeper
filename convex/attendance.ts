import { getFactoryLocalDateKey } from "./localDate";
import { internalMutation, internalQuery, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { validateAttendanceBatch, validateAttendanceEvent, type AttendanceEvent } from "./attendanceValidation";
import { createActiveKioskResolver } from "./kioskLookup";
import {
  buildConservativeFactoryLocalTimestampRanges,
  getFactoryLocalTimestamp,
  timestampBelongsToFactoryLocalDate,
} from "./localDate";
import { assertPortalRole } from "./access";
import { createRecognitionTimestampSortKey } from "./recognitionTimestamp";

// Keep the instant separate from the factory wall time used by schedule rules
// and API display. In a repeated DST hour, wall time alone reverses scans.
function withFactoryLocalTimestamp(record: any, sortKey: (timestamp: string) => string) {
  const originalTimestamp = record.timestamp;
  const localTimestamp = getFactoryLocalTimestamp(originalTimestamp) || originalTimestamp;
  const fraction = originalTimestamp.match(/\.([0-9]+)/)?.[1];
  const timestamp = fraction && !localTimestamp.includes(".")
    ? `${localTimestamp}.${fraction}`
    : localTimestamp;
  return { ...record, timestamp, chronologicalKey: sortKey(originalTimestamp) };
}

function compareAttendance(a: any, b: any) {
  const left = a.chronologicalKey || "~";
  const right = b.chronologicalKey || "~";
  return left < right ? -1 : left > right ? 1 : String(a._id).localeCompare(String(b._id));
}

export async function listAttendanceByTimestampRange(
  ctx: any,
  date: string,
  workerId?: string,
) {
  const rowsById = new Map<string, any>();
  const sortKey = createRecognitionTimestampSortKey();
  for (const range of buildConservativeFactoryLocalTimestampRanges(date)) {
    const query = workerId
      ? ctx.db
          .query("attendance")
          .withIndex("by_timestamp", (q: any) => q.gte("timestamp", range.startTimestamp).lt("timestamp", range.endTimestamp))
          .filter((q: any) => q.eq(q.field("workerId"), workerId))
      : ctx.db
          .query("attendance")
          .withIndex("by_timestamp", (q: any) => q.gte("timestamp", range.startTimestamp).lt("timestamp", range.endTimestamp));
    const rows = await query.collect();
    for (const row of rows) {
      if (timestampBelongsToFactoryLocalDate(row.timestamp, date)) {
        rowsById.set(String(row._id), withFactoryLocalTimestamp(row, sortKey));
      }
    }
  }
  return Array.from(rowsById.values()).sort(compareAttendance);
}

export async function listEffectiveAttendanceByTimestampRange(
  ctx: any,
  date: string,
  workerId?: string,
) {
  const [rawRecords, corrections] = await Promise.all([
    listAttendanceByTimestampRange(ctx, date, workerId),
    workerId
      ? ctx.db
          .query("attendanceCorrections")
          .withIndex("by_worker_date", (q: any) => q.eq("workerId", workerId).eq("date", date))
          .collect()
      : ctx.db
          .query("attendanceCorrections")
          .withIndex("by_date", (q: any) => q.eq("date", date))
          .collect(),
  ]);

  const voidedIds = new Set(
    corrections
      .filter((correction: any) => correction.action === "void_event" && correction.originalAttendanceId)
      .map((correction: any) => String(correction.originalAttendanceId)),
  );

  const effective = rawRecords
    .filter((record: any) => !voidedIds.has(String(record._id)))
    .map((record: any) => ({
      ...record,
      correctionId: undefined,
      corrected: false,
      source: "kiosk",
    }));

  const sortKey = createRecognitionTimestampSortKey();
  for (const correction of corrections) {
    if (correction.action !== "add_clock_in" && correction.action !== "add_clock_out") continue;
    if (!correction.correctedTimestamp || !correction.eventType) continue;
    effective.push(withFactoryLocalTimestamp({
      _id: `correction:${String(correction._id)}`,
      workerId: correction.workerId,
      eventType: correction.eventType,
      kioskId: "supervisor_correction",
      timestamp: correction.correctedTimestamp,
      idempotencyKey: `correction:${String(correction._id)}`,
      synced: true,
      workerName: undefined,
      confidence: undefined,
      livenessConfirmed: undefined,
      correctionId: String(correction._id),
      correctionReason: correction.reason,
      correctionSupervisorName: correction.supervisorName,
      corrected: true,
      source: "correction",
    }, sortKey));
  }

  effective.sort(compareAttendance);
  return effective;
}

export const list = query({
  args: {
    date: v.optional(v.string()),
    workerId: v.optional(v.string()),
    includeCorrections: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await assertPortalRole(ctx, ["admin", "enrollment", "viewer"]);
    const date = args.date || getFactoryLocalDateKey(new Date().toISOString())!;
    const records: any[] = args.includeCorrections === false
      ? await listAttendanceByTimestampRange(ctx, date, args.workerId)
      : await listEffectiveAttendanceByTimestampRange(ctx, date, args.workerId);
    records.reverse(); // Helpers return chronological order; display newest first.

    // Join worker and kiosk data
    const result: any[] = [];
    const resolveKiosk = createActiveKioskResolver(ctx);
    for (const a of records) {
      const worker = a.workerId ? await ctx.db.get(a.workerId as any).catch(() => null) : null;
      const kiosk = await resolveKiosk(a.kioskId);
      result.push({
        id: a._id,
        worker_id: a.workerId,
        event_type: a.eventType,
        kiosk_id: a.kioskId || null,
        timestamp: a.timestamp,
        timestamp_utc: a.chronologicalKey ? `${a.chronologicalKey}Z`.replace(".Z", "Z") : null,
        synced: a.synced ? 1 : 0,
        worker_name: (worker as any)?.name || a.workerName || "",
        worker_department: (worker as any)?.department || "",
        kiosk_name: a.source === "correction" ? "Supervisor correction" : (kiosk as any)?.name || null,
        confidence: a.confidence || 0,
        liveness_confirmed: a.livenessConfirmed ? 1 : 0,
        source: a.source || "kiosk",
        note: a.note || null,
        corrected: Boolean(a.corrected),
        correction_id: a.correctionId || null,
        correction_reason: a.correctionReason || null,
        correction_supervisor_name: a.correctionSupervisorName || null,
      });
    }
    return result;
  },
});

const attendanceEventInput = v.object({
  id: v.optional(v.string()),
  workerId: v.string(),
  eventType: v.string(),
  kioskId: v.optional(v.string()),
  timestamp: v.string(),
  idempotencyKey: v.optional(v.string()),
  workerName: v.optional(v.string()),
  confidence: v.optional(v.float64()),
  livenessConfirmed: v.optional(v.boolean()),
  note: v.optional(v.string()),
});

// A retry can restore metadata dropped by older ingest versions, but cannot
// change a recorded note. Older clients may omit notes without erasing them.
async function preserveAttendanceNote(ctx: MutationCtx, existing: { _id: Id<"attendance">; note?: string }, event: AttendanceEvent) {
  if (event.note === undefined) return;
  if (existing.note !== undefined && existing.note !== event.note) {
    throw new ConvexError({ code: "INVALID_ATTENDANCE", message: "A retry cannot change the attendance note" });
  }
  if (existing.note === undefined) await ctx.db.patch(existing._id, { note: event.note });
}

async function insertAttendanceEvent(ctx: MutationCtx, event: AttendanceEvent) {
  const workerId = ctx.db.normalizeId("workers", event.workerId);
  if (!workerId || !(await ctx.db.get(workerId))) {
    throw new ConvexError({ code: "INVALID_ATTENDANCE", message: "workerId must identify an existing worker" });
  }
  // Inactive workers' offline evidence is still valid and must not be lost.
  if (event.idempotencyKey) {
    const existing = await ctx.db.query("attendance")
      .withIndex("by_kiosk_and_idempotency_key", (q) => q.eq("kioskId", event.kioskId).eq("idempotencyKey", event.idempotencyKey))
      .first();
    if (existing) {
      if (existing.workerId !== event.workerId || existing.eventType !== event.eventType || existing.timestamp !== event.timestamp) {
        throw new ConvexError({ code: "INVALID_ATTENDANCE", message: "An idempotency key cannot be reused for different attendance evidence" });
      }
      await preserveAttendanceNote(ctx, existing, event);
      return { id: existing._id, inserted: false };
    }
  }
  const sameEvent = await ctx.db.query("attendance")
    .withIndex("by_worker_timestamp_type_kiosk", (q) => q.eq("workerId", event.workerId).eq("timestamp", event.timestamp).eq("eventType", event.eventType).eq("kioskId", event.kioskId))
    .first();
  // Legacy events without stable keys retain exact-event deduplication. Two
  // independently keyed scans at the same instant remain distinct evidence.
  if (sameEvent && (!event.idempotencyKey || !sameEvent.idempotencyKey)) {
    await preserveAttendanceNote(ctx, sameEvent, event);
    if (event.idempotencyKey) await ctx.db.patch(sameEvent._id, { idempotencyKey: event.idempotencyKey });
    return { id: sameEvent._id, inserted: false };
  }
  const id = await ctx.db.insert("attendance", { ...event, synced: true });
  return { id, inserted: true };
}

export const createFromHttp = internalMutation({
  args: {
    workerId: v.string(),
    eventType: v.string(),
    kioskId: v.optional(v.string()),
    timestamp: v.optional(v.string()),
    note: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
  },
  returns: v.object({ id: v.id("attendance") }),
  handler: async (ctx, args) => {
    const kioskId = args.kioskId?.trim() || undefined;
    const idempotencyKey = args.idempotencyKey?.trim() || undefined;
    const existing = idempotencyKey ? await ctx.db.query("attendance")
      .withIndex("by_kiosk_and_idempotency_key", (q) => q.eq("kioskId", kioskId).eq("idempotencyKey", idempotencyKey)).first() : null;
    const event = validateAttendanceEvent({ ...args, timestamp: args.timestamp ?? existing?.timestamp ?? new Date().toISOString() });
    const result = await insertAttendanceEvent(ctx, event);
    return { id: result.id };
  },
});

export const bulkCreateFromHttp = internalMutation({
  args: { events: v.array(attendanceEventInput), receiptHash: v.optional(v.string()) },
  returns: v.object({ synced: v.number(), acknowledged: v.number() }),
  handler: async (ctx, args) => {
    const events = validateAttendanceBatch(args.events);
    if (args.receiptHash !== undefined) {
      validateReceiptDigests([args.receiptHash]);
      const receipt = await ctx.db.query("attendanceIngestReceipts")
        .withIndex("by_digest", q => q.eq("digest", args.receiptHash!)).first();
      if (receipt) {
        if (receipt.acknowledged !== events.length) throw new ConvexError({ code: "INVALID_ATTENDANCE", message: "Receipt size mismatch" });
        return { synced: 0, acknowledged: receipt.acknowledged };
      }
    }
    let synced = 0;
    for (const event of events) {
      if ((await insertAttendanceEvent(ctx, event)).inserted) synced++;
    }
    if (args.receiptHash !== undefined) {
      await ctx.db.insert("attendanceIngestReceipts", { digest: args.receiptHash, acknowledged: events.length });
    }
    // Acknowledgement includes existing rows. The transaction rejects the
    // entire batch if any event is invalid; callers can safely retry it.
    return { synced, acknowledged: events.length };
  },
});


export function validateReceiptDigests(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 500 || value.some(digest => typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))) {
    throw new ConvexError({ code: "INVALID_ATTENDANCE", message: "digests must contain at most 500 lowercase SHA-256 hashes" });
  }
  return value;
}

export const receiptStatus = internalQuery({
  args: { digests: v.array(v.string()) },
  returns: v.array(v.boolean()),
  handler: async (ctx, args) => {
    const digests = validateReceiptDigests(args.digests);
    return await Promise.all(digests.map(async digest => Boolean(await ctx.db.query("attendanceIngestReceipts")
      .withIndex("by_digest", q => q.eq("digest", digest)).first())));
  },
});
