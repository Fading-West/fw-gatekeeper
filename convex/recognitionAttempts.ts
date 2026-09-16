import { getFactoryLocalDateKey } from "./localDate";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import {
  buildConservativeFactoryLocalTimestampRanges,
  timestampBelongsToFactoryLocalDate,
} from "./localDate";
import { assertPortalRole } from "./access";

const attemptInput = v.object({
  timestamp: v.string(),
  kioskId: v.string(),
  sourceAttemptId: v.optional(v.string()),
  legacySourceAttemptId: v.optional(v.string()),
  faceDetected: v.boolean(),
  candidateWorkerId: v.optional(v.string()),
  candidateWorkerName: v.optional(v.string()),
  bestScore: v.optional(v.float64()),
  secondBestScore: v.optional(v.float64()),
  scoreMargin: v.optional(v.float64()),
  decision: v.string(),
  threshold: v.float64(),
  livenessConfirmed: v.optional(v.boolean()),
  modelVersion: v.optional(v.string()),
  imageQuality: v.optional(v.float64()),
  faceQuality: v.optional(v.float64()),
  brightness: v.optional(v.float64()),
  blur: v.optional(v.float64()),
  reviewed: v.optional(v.boolean()),
  reviewedLabel: v.optional(v.string()),
  reviewedNote: v.optional(v.string()),
  reviewedAt: v.optional(v.string()),
});

function normalizeOptionalText(value?: string) {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function normalizeRequiredText(value: string, label: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  return trimmed;
}

function clampLimit(limit?: number) {
  if (!limit || !Number.isFinite(limit)) return 250;
  return Math.max(1, Math.min(1000, Math.floor(limit)));
}

function getScoreMargin(attempt: {
  bestScore?: number;
  secondBestScore?: number;
  scoreMargin?: number;
}) {
  if (attempt.scoreMargin !== undefined) return attempt.scoreMargin;
  if (attempt.bestScore !== undefined && attempt.secondBestScore !== undefined) {
    return attempt.bestScore - attempt.secondBestScore;
  }
  return undefined;
}

function serializeAttempt(attempt: any) {
  return {
    id: attempt._id,
    timestamp: attempt.timestamp,
    kiosk_id: attempt.kioskId,
    source_attempt_id: attempt.sourceAttemptId || null,
    face_detected: attempt.faceDetected ? 1 : 0,
    candidate_worker_id: attempt.candidateWorkerId || null,
    candidate_worker_name: attempt.candidateWorkerName || null,
    best_score: attempt.bestScore ?? null,
    second_best_score: attempt.secondBestScore ?? null,
    score_margin: attempt.scoreMargin ?? null,
    decision: attempt.decision,
    threshold: attempt.threshold,
    liveness_confirmed:
      attempt.livenessConfirmed === undefined ? null : attempt.livenessConfirmed ? 1 : 0,
    model_version: attempt.modelVersion || null,
    image_quality: attempt.imageQuality ?? null,
    face_quality: attempt.faceQuality ?? null,
    brightness: attempt.brightness ?? null,
    blur: attempt.blur ?? null,
    reviewed: attempt.reviewed ? 1 : 0,
    reviewed_label: attempt.reviewedLabel || null,
    reviewed_note: attempt.reviewedNote || null,
    reviewed_at: attempt.reviewedAt || null,
    created_at: attempt.createdAt,
    updated_at: attempt.updatedAt || null,
  };
}

function normalizeAttempt(attempt: {
  timestamp: string;
  kioskId: string;
  sourceAttemptId?: string;
  legacySourceAttemptId?: string;
  faceDetected: boolean;
  candidateWorkerId?: string;
  candidateWorkerName?: string;
  bestScore?: number;
  secondBestScore?: number;
  scoreMargin?: number;
  decision: string;
  threshold: number;
  livenessConfirmed?: boolean;
  modelVersion?: string;
  imageQuality?: number;
  faceQuality?: number;
  brightness?: number;
  blur?: number;
  reviewed?: boolean;
  reviewedLabel?: string;
  reviewedNote?: string;
  reviewedAt?: string;
}) {
  const reviewed = attempt.reviewed ?? false;
  return {
    timestamp: normalizeRequiredText(attempt.timestamp, "timestamp"),
    kioskId: normalizeRequiredText(attempt.kioskId, "kioskId"),
    sourceAttemptId: normalizeOptionalText(attempt.sourceAttemptId),
    legacySourceAttemptId: normalizeOptionalText(attempt.legacySourceAttemptId),
    faceDetected: attempt.faceDetected,
    candidateWorkerId: normalizeOptionalText(attempt.candidateWorkerId),
    candidateWorkerName: normalizeOptionalText(attempt.candidateWorkerName),
    bestScore: attempt.bestScore,
    secondBestScore: attempt.secondBestScore,
    scoreMargin: getScoreMargin(attempt),
    decision: normalizeRequiredText(attempt.decision, "decision"),
    threshold: attempt.threshold,
    livenessConfirmed: attempt.livenessConfirmed,
    modelVersion: normalizeOptionalText(attempt.modelVersion),
    imageQuality: attempt.imageQuality,
    faceQuality: attempt.faceQuality,
    brightness: attempt.brightness,
    blur: attempt.blur,
    reviewed,
    reviewedLabel: normalizeOptionalText(attempt.reviewedLabel),
    reviewedNote: normalizeOptionalText(attempt.reviewedNote),
    reviewedAt: reviewed ? normalizeOptionalText(attempt.reviewedAt) : undefined,
  };
}

// Review annotations are mutable portal state, not original kiosk evidence.
const evidenceFields = [
  "timestamp", "kioskId", "faceDetected", "candidateWorkerId", "candidateWorkerName",
  "bestScore", "secondBestScore", "scoreMargin", "decision", "threshold",
  "livenessConfirmed", "modelVersion", "imageQuality", "faceQuality", "brightness", "blur",
] as const;
function sameEvidence(
  existing: Partial<ReturnType<typeof normalizeAttempt>>,
  incoming: ReturnType<typeof normalizeAttempt>,
) {
  return evidenceFields.every(field => existing[field] === incoming[field]);
}

async function listRangeInternal(
  ctx: any,
  args: {
    startTimestamp: string;
    endTimestamp: string;
    kioskId?: string;
    reviewed?: boolean;
    limit?: number;
  },
  options: { applyLimit?: boolean } = {},
) {
  const kioskId = normalizeOptionalText(args.kioskId);
  const limit = clampLimit(args.limit);
  const start = args.startTimestamp;
  const end = args.endTimestamp;

  let builder;
  if (kioskId && args.reviewed !== undefined) {
    builder = ctx.db
      .query("recognitionAttempts")
      .withIndex("by_kiosk_reviewed_timestamp", (q: any) =>
        q.eq("kioskId", kioskId).eq("reviewed", args.reviewed).gte("timestamp", start).lt("timestamp", end),
      );
  } else if (kioskId) {
    builder = ctx.db
      .query("recognitionAttempts")
      .withIndex("by_kiosk_timestamp", (q: any) =>
        q.eq("kioskId", kioskId).gte("timestamp", start).lt("timestamp", end),
      );
  } else if (args.reviewed !== undefined) {
    builder = ctx.db
      .query("recognitionAttempts")
      .withIndex("by_reviewed_timestamp", (q: any) =>
        q.eq("reviewed", args.reviewed).gte("timestamp", start).lt("timestamp", end),
      );
  } else {
    builder = ctx.db
      .query("recognitionAttempts")
      .withIndex("by_timestamp", (q: any) => q.gte("timestamp", start).lt("timestamp", end));
  }

  const attempts = options.applyLimit === false
    ? await builder.order("desc").collect()
    : await builder.order("desc").take(limit);
  return attempts.map(serializeAttempt);
}

export async function listRecognitionAttemptsByFactoryDate(
  ctx: any,
  args: {
    date: string;
    kioskId?: string;
    reviewed?: boolean;
    limit?: number;
    decision?: string;
    confidenceBand?: string;
    reviewStatus?: string;
  },
) {
  const rows = await listAllRecognitionAttemptsByFactoryDate(ctx, args);
  const limit = clampLimit(args.limit);
  // Apply portal filters to the full date selection before imposing the display
  // cap. Otherwise newer nonmatching scans hide older matching evidence.
  const matches = rows.filter((row) => {
    const decision = args.decision;
    const decisionMatches = !decision || decision === "all" || row.decision === decision ||
      ((decision === "accepted" || decision === "rejected") && row.decision.startsWith(decision));
    const score = row.best_score;
    const band = typeof score !== "number" || !Number.isFinite(score)
      ? null : score >= 0.45 ? "high" : score >= 0.3 ? "medium" : "low";
    const confidenceMatches = !args.confidenceBand || args.confidenceBand === "all" || band === args.confidenceBand;
    const label = row.reviewed_label ?? "confirmed";
    const reviewStatus = !row.reviewed ? "unreviewed"
      : ["confirmed", "corrected", "ignored"].includes(label) ? label : "unreviewed";
    const reviewMatches = !args.reviewStatus || args.reviewStatus === "all" || reviewStatus === args.reviewStatus;
    return decisionMatches && confidenceMatches && reviewMatches;
  });
  return matches.slice(0, limit);
}

export async function listAllRecognitionAttemptsByFactoryDate(
  ctx: any,
  args: {
    date: string;
    kioskId?: string;
    reviewed?: boolean;
  },
) {
  const rowsById = new Map<string, any>();
  const kioskId = normalizeOptionalText(args.kioskId);

  for (const range of buildConservativeFactoryLocalTimestampRanges(args.date)) {
    const rows = await listRangeInternal(ctx, {
      startTimestamp: range.startTimestamp,
      endTimestamp: range.endTimestamp,
      kioskId,
      reviewed: args.reviewed,
    }, { applyLimit: false });
    for (const row of rows) {
      if (timestampBelongsToFactoryLocalDate(row.timestamp, args.date)) {
        rowsById.set(String(row.id), row);
      }
    }
  }

  return Array.from(rowsById.values())
    .sort((a: any, b: any) => String(b.timestamp).localeCompare(String(a.timestamp)));
}

async function ingestAttemptBatch(ctx: MutationCtx, args: {
  attempts: Array<{
    timestamp: string;
    kioskId: string;
    sourceAttemptId?: string;
    legacySourceAttemptId?: string;
    faceDetected: boolean;
    candidateWorkerId?: string;
    candidateWorkerName?: string;
    bestScore?: number;
    secondBestScore?: number;
    scoreMargin?: number;
    decision: string;
    threshold: number;
    livenessConfirmed?: boolean;
    modelVersion?: string;
    imageQuality?: number;
    faceQuality?: number;
    brightness?: number;
    blur?: number;
    reviewed?: boolean;
    reviewedLabel?: string;
    reviewedNote?: string;
    reviewedAt?: string;
  }>;
}) {
    const seenLegacyKeys = new Set<string>();
    const insertedIds = [];
    let skipped = 0;
    const now = new Date().toISOString();

    for (const attempt of args.attempts) {
      const normalized = normalizeAttempt(attempt);
      if (normalized.sourceAttemptId) {
        // Reads see earlier inserts in this transaction, so conflicting keys in
        // one batch receive the same checks as a later network retry.
        const existing = await ctx.db
          .query("recognitionAttempts")
          .withIndex("by_source_attempt_id", (q) => q.eq("sourceAttemptId", normalized.sourceAttemptId))
          .first() || await ctx.db
          .query("recognitionAttempts")
          .withIndex("by_legacy_source_attempt_id", (q) => q.eq("legacySourceAttemptId", normalized.sourceAttemptId))
          .first();
        if (existing) {
          if (!sameEvidence(existing, normalized)) {
            throw new ConvexError({
              code: "RECOGNITION_ATTEMPT_CONFLICT",
              message: "Recognition attempt ID was reused with different evidence.",
            });
          }
          skipped++;
          continue;
        }
        if (normalized.legacySourceAttemptId) {
          const legacy = await ctx.db.query("recognitionAttempts")
            .withIndex("by_source_attempt_id", (q) => q.eq("sourceAttemptId", normalized.legacySourceAttemptId))
            .first();
          // Only adopt an exact old upload. A row number reused after a reset
          // is distinct evidence and must be inserted under its new UUID.
          if (legacy && sameEvidence(legacy, normalized)) {
            await ctx.db.patch(legacy._id, {
              sourceAttemptId: normalized.sourceAttemptId,
              legacySourceAttemptId: normalized.legacySourceAttemptId,
            });
            skipped++;
            continue;
          }
        }
      } else {
        // Preserve the previous behavior for unkeyed legacy clients.
        const key = `${normalized.kioskId}:${normalized.timestamp}:${normalized.candidateWorkerId || ""}:${normalized.decision}`;
        if (seenLegacyKeys.has(key)) {
          skipped++;
          continue;
        }
        seenLegacyKeys.add(key);
      }

      const id = await ctx.db.insert("recognitionAttempts", {
        ...normalized,
        // Only adopted records retain aliases, so an unrelated reset attempt
        // cannot claim the old event's identity.
        legacySourceAttemptId: undefined,
        reviewedAt: normalized.reviewed ? normalized.reviewedAt || now : undefined,
        createdAt: now,
      });
      insertedIds.push(id);
    }

    return { ingested: insertedIds.length, skipped, ids: insertedIds };
}

export const bulkIngestFromHttp = internalMutation({
  args: { attempts: v.array(attemptInput) },
  returns: v.object({
    ingested: v.number(),
    skipped: v.number(),
    ids: v.array(v.id("recognitionAttempts")),
  }),
  handler: ingestAttemptBatch,
});

export const listByDate = query({
  args: {
    date: v.optional(v.string()),
    kioskId: v.optional(v.string()),
    reviewed: v.optional(v.boolean()),
    limit: v.optional(v.float64()),
    decision: v.optional(v.string()),
    confidenceBand: v.optional(v.string()),
    reviewStatus: v.optional(v.string()),
  },
  returns: v.array(v.object({
    id: v.id("recognitionAttempts"),
    timestamp: v.string(),
    kiosk_id: v.string(),
    source_attempt_id: v.union(v.string(), v.null()),
    face_detected: v.number(),
    candidate_worker_id: v.union(v.string(), v.null()),
    candidate_worker_name: v.union(v.string(), v.null()),
    best_score: v.union(v.number(), v.null()),
    second_best_score: v.union(v.number(), v.null()),
    score_margin: v.union(v.number(), v.null()),
    decision: v.string(),
    threshold: v.number(),
    liveness_confirmed: v.union(v.number(), v.null()),
    model_version: v.union(v.string(), v.null()),
    image_quality: v.union(v.number(), v.null()),
    face_quality: v.union(v.number(), v.null()),
    brightness: v.union(v.number(), v.null()),
    blur: v.union(v.number(), v.null()),
    reviewed: v.number(),
    reviewed_label: v.union(v.string(), v.null()),
    reviewed_note: v.union(v.string(), v.null()),
    reviewed_at: v.union(v.string(), v.null()),
    created_at: v.string(),
    updated_at: v.union(v.string(), v.null()),
  })),
  handler: async (ctx, args) => {
    await assertPortalRole(ctx, ["admin", "enrollment", "viewer"]);
    const date = args.date || getFactoryLocalDateKey(new Date().toISOString())!;
    return await listRecognitionAttemptsByFactoryDate(ctx, {
      date,
      kioskId: args.kioskId,
      reviewed: args.reviewed,
      limit: args.limit,
      decision: args.decision,
      confidenceBand: args.confidenceBand,
      reviewStatus: args.reviewStatus,
    });
  },
});

export const getById = query({
  args: {
    id: v.id("recognitionAttempts"),
    date: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await assertPortalRole(ctx, ["admin", "enrollment", "viewer"]);
    const attempt = await ctx.db.get(args.id);
    if (!attempt) return null;
    if (args.date && !timestampBelongsToFactoryLocalDate(attempt.timestamp, args.date)) {
      return null;
    }
    return serializeAttempt(attempt);
  },
});

export const updateReview = mutation({
  args: {
    id: v.id("recognitionAttempts"),
    reviewed: v.optional(v.boolean()),
    reviewedLabel: v.optional(v.string()),
    reviewedNote: v.optional(v.string()),
    reviewedAt: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await assertPortalRole(ctx, ["admin", "enrollment"]);
    const existing = await ctx.db.get(args.id);
    if (!existing) {
      throw new Error("Recognition attempt not found");
    }

    const reviewed = args.reviewed ?? true;
    const now = new Date().toISOString();
    const updates: Record<string, unknown> = {
      reviewed,
      updatedAt: now,
    };
    if (args.reviewedLabel !== undefined) {
      updates.reviewedLabel = normalizeOptionalText(args.reviewedLabel);
    }
    if (args.reviewedNote !== undefined) {
      updates.reviewedNote = normalizeOptionalText(args.reviewedNote);
    }
    updates.reviewedAt = reviewed ? normalizeOptionalText(args.reviewedAt) || existing.reviewedAt || now : undefined;

    await ctx.db.patch(args.id, updates);

    const updated = await ctx.db.get(args.id);
    return updated ? serializeAttempt(updated) : null;
  },
});
