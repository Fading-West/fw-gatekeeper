import { getFactoryLocalDateKey } from "./localDate";
import { isValidAttendanceTimestamp } from "./attendanceValidation";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import {
  buildConservativeFactoryLocalTimestampRanges,
  timestampBelongsToFactoryLocalDate,
} from "./localDate";
import { assertPortalRole } from "./access";
import { writeAuditLog } from "./audit";
import { createRecognitionTimestampSortKey, getRecognitionDisplayTimestamp } from "./recognitionTimestamp";
import { sha256 } from "@oslojs/crypto/sha2";

const REVIEW_CONFLICT_MESSAGE = "This recognition review changed. Refresh the attempts and review the current decision before saving.";

function reviewVersion(attempt: any) {
  // Include content: separate mutations can share the same millisecond, and
  // reviewedAt may be retained when an operator changes an existing review.
  // The revision also detects a change away and back to identical content.
  const state = JSON.stringify([String(attempt._id), attempt.reviewRevision ?? 0, attempt.reviewed,
    attempt.reviewedLabel ?? null, attempt.reviewedNote ?? null,
    attempt.reviewedAt ?? null, attempt.updatedAt ?? null]);
  return Array.from(sha256(new TextEncoder().encode(state)), byte => byte.toString(16).padStart(2, "0")).join("");
}

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
    review_version: reviewVersion(attempt),
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

function withFactoryLocalDisplayTimestamp(attempt: any, timestampKey = createRecognitionTimestampSortKey()) {
  const key = timestampKey(attempt.timestamp);
  return {
    ...attempt,
    timestamp: getRecognitionDisplayTimestamp(attempt.timestamp) || attempt.timestamp,
    timestamp_utc: key ? `${key}Z`.replace(".Z", "Z") : null,
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
  for (const [field, value, minimum, maximum] of [
    ["bestScore", attempt.bestScore, -1, 1], ["secondBestScore", attempt.secondBestScore, -1, 1],
    ["scoreMargin", attempt.scoreMargin, -2, 2], ["threshold", attempt.threshold, 0, 1],
    ["imageQuality", attempt.imageQuality, 0, 1], ["faceQuality", attempt.faceQuality, 0, 1],
    ["brightness", attempt.brightness, 0, 255], ["blur", attempt.blur, 0, Number.MAX_VALUE],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < minimum - 1e-12 || value > maximum + 1e-12)) {
      throw new ConvexError({ code: "INVALID_RECOGNITION_METRIC", message: `Invalid recognition metric: ${field}` });
    }
  }

  const timestamp = attempt.timestamp.trim();
  if (!isValidAttendanceTimestamp(timestamp) || !createRecognitionTimestampSortKey()(timestamp)) {
    throw new ConvexError({ code: "INVALID_RECOGNITION_TIMESTAMP", message: "Recognition timestamp must identify a valid factory-local or offset instant" });
  }
  const reviewed = false; // Kiosks supply evidence; only portal operators may review it.
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
    reviewedLabel: undefined,
    reviewedNote: undefined,
    reviewedAt: undefined,
  };
}

// Review annotations are mutable portal state, not original kiosk evidence.
const evidenceFields = [
  "timestamp", "kioskId", "faceDetected", "candidateWorkerId", "candidateWorkerName",
  "bestScore", "secondBestScore", "scoreMargin", "decision", "threshold",
  "livenessConfirmed", "modelVersion", "imageQuality", "faceQuality", "brightness", "blur",
] as const;
function sameEvidence(
  existing: Partial<Pick<ReturnType<typeof normalizeAttempt>, typeof evidenceFields[number]>>,
  incoming: ReturnType<typeof normalizeAttempt>,
) {
  return evidenceFields.every(field => existing[field] === incoming[field]);
}

function recognitionRangeQuery(
  ctx: any,
  args: {
    startTimestamp: string;
    endTimestamp: string;
    kioskId?: string;
    reviewed?: boolean;
    limit?: number;
  },
) {
  const kioskId = normalizeOptionalText(args.kioskId);
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

  return builder.order("desc");
}

async function listRangeInternal(
  ctx: any,
  args: { startTimestamp: string; endTimestamp: string; kioskId?: string; reviewed?: boolean; limit?: number },
  options: { applyLimit?: boolean } = {},
) {
  const builder = recognitionRangeQuery(ctx, args);
  const attempts = options.applyLimit === false
    ? await builder.collect()
    : await builder.take(clampLimit(args.limit));
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
  return (await selectRecognitionAttemptsByFactoryDate(ctx, args)).attempts;
}

// Scan windows follow the raw timestamp index, including its tie breakers.
// Sorting happens only within a window: mixed timestamp representations cannot
// support a chronological cursor without normalizing stored evidence first.
const SELECTION_READ_LIMIT = 1000;
const SELECTION_BYTE_LIMIT = 4 * 1024 * 1024;

async function selectRecognitionAttemptsByFactoryDate(
  ctx: any,
  args: {
    date: string;
    kioskId?: string;
    reviewed?: boolean;
    limit?: number;
    decision?: string;
    confidenceBand?: string;
    reviewStatus?: string;
    scanCursor?: string;
  },
) {
  // The conservative range is one continuous index interval. Use Convex's
  // cursor rather than a timestamp boundary so equal timestamps are not lost.
  const [range] = buildConservativeFactoryLocalTimestampRanges(args.date);
  const page = await recognitionRangeQuery(ctx, { ...args, ...range }).paginate({
    cursor: args.scanCursor ?? null,
    numItems: SELECTION_READ_LIMIT,
    maximumRowsRead: SELECTION_READ_LIMIT + 1,
    maximumBytesRead: SELECTION_BYTE_LIMIT,
  });
  const summaryLimited = Boolean(args.scanCursor) || !page.isDone;
  const rows: ReturnType<typeof serializeAttempt>[] = page.page.map(serializeAttempt).filter((row: any) =>
    timestampBelongsToFactoryLocalDate(row.timestamp, args.date));
  const timestampKey = createRecognitionTimestampSortKey();
  rows.sort((a: any, b: any) => {
    const aKey = timestampKey(a.timestamp);
    const bKey = timestampKey(b.timestamp);
    return aKey === bKey ? String(a.id).localeCompare(String(b.id)) : aKey < bKey ? 1 : -1;
  });
  const limit = clampLimit(args.limit);
  // Apply portal filters to the bounded selection before imposing the display
  // cap. Matches beyond the read bound are explicitly reported as incomplete.
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
  // Normalize only after filtering and sorting the original evidence instants.
  const scores = matches.flatMap(row => typeof row.best_score === "number" ? [row.best_score] : []).sort((a, b) => a - b);
  const midpoint = Math.floor(scores.length / 2);
  const decisionFilter = args.decision;
  const allowsDecision = (matchesCategory: (decision: string) => boolean) =>
    !decisionFilter || decisionFilter === "all" || matchesCategory(decisionFilter);
  // A filter can prove a category empty even if other indexed rows are unread.
  const possibleCounts = {
    accepted: allowsDecision(decision => decision.startsWith("accepted")),
    rejected: allowsDecision(decision => decision.startsWith("rejected")),
    unknown: allowsDecision(decision => decision === "unknown"),
    near_miss: allowsDecision(decision => decision === "near_miss"),
    low_margin_accepted: allowsDecision(decision => decision.startsWith("accepted")),
    review_backlog: !args.reviewStatus || args.reviewStatus === "all" || args.reviewStatus === "unreviewed",
    total: true,
  };
  const summaryLimitedFields = summaryLimited
    ? Object.entries(possibleCounts).filter(([, possible]) => possible).map(([field]) => field)
    : [];
  return {
    attempts: matches.slice(0, limit).map(row => withFactoryLocalDisplayTimestamp(row, timestampKey)),
    summary: {
      accepted: matches.filter(row => row.decision.startsWith("accepted")).length,
      rejected: matches.filter(row => row.decision.startsWith("rejected")).length,
      unknown: matches.filter(row => row.decision === "unknown").length,
      near_miss: matches.filter(row => row.decision === "near_miss").length,
      low_margin_accepted: matches.filter(row => row.decision.startsWith("accepted") && typeof row.score_margin === "number" && row.score_margin <= 0.08).length,
      median_score: summaryLimited || !scores.length ? null : scores.length % 2 ? scores[midpoint] : (scores[midpoint - 1] + scores[midpoint]) / 2,
      review_backlog: matches.filter(row => !row.reviewed || (row.reviewed_label != null && !["confirmed", "corrected", "ignored"].includes(row.reviewed_label))).length,
      total: matches.length,
    },
    truncated: summaryLimited || matches.length > limit,
    summary_limited: summaryLimited,
    summary_limited_fields: summaryLimitedFields,
    next_scan_cursor: page.isDone ? null : page.continueCursor,
  };
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

  const timestampKey = createRecognitionTimestampSortKey();
  return Array.from(rowsById.values())
    .map(row => ({ row, key: timestampKey(row.timestamp) }))
    .sort((a, b) => {
      if (a.key !== b.key) return a.key < b.key ? 1 : -1;
      return String(a.row.id).localeCompare(String(b.row.id));
    })
    .map(({ row }) => row);
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
    const seenLegacyEvidence = new Map<string, ReturnType<typeof normalizeAttempt>[]>();
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
        if (seenLegacyEvidence.get(key)?.some(row => sameEvidence(row, normalized))) {
          skipped++;
          continue;
        }
        seenLegacyEvidence.set(key, [...seenLegacyEvidence.get(key) ?? [], normalized]);
        const prior = await ctx.db.query("recognitionAttempts")
          .withIndex("by_kiosk_timestamp_candidate_decision", q => q.eq("kioskId", normalized.kioskId).eq("timestamp", normalized.timestamp).eq("candidateWorkerId", normalized.candidateWorkerId).eq("decision", normalized.decision))
          .filter(q => q.and(q.eq(q.field("sourceAttemptId"), undefined),
            ...evidenceFields.map(field => q.eq(q.field(field), normalized[field]))))
          .first();
        if (prior && sameEvidence(prior, normalized)) {
          skipped++;
          continue;
        }
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
    scanCursor: v.optional(v.string()),
  },
  returns: v.object({
    attempts: v.array(v.object({
      id: v.id("recognitionAttempts"),
      review_version: v.string(),
      timestamp: v.string(),
      timestamp_utc: v.union(v.string(), v.null()),
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
    summary: v.object({
      accepted: v.number(),
      rejected: v.number(),
      unknown: v.number(),
      near_miss: v.number(),
      low_margin_accepted: v.number(),
      median_score: v.union(v.number(), v.null()),
      review_backlog: v.number(),
      total: v.number(),
    }),
    truncated: v.boolean(),
    summary_limited: v.boolean(),
    summary_limited_fields: v.array(v.string()),
    next_scan_cursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    await assertPortalRole(ctx, ["admin", "enrollment", "viewer"]);
    const date = args.date || getFactoryLocalDateKey(new Date().toISOString())!;
    return await selectRecognitionAttemptsByFactoryDate(ctx, {
      date,
      kioskId: args.kioskId,
      reviewed: args.reviewed,
      limit: args.limit,
      decision: args.decision,
      confidenceBand: args.confidenceBand,
      reviewStatus: args.reviewStatus,
      scanCursor: args.scanCursor,
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
    return withFactoryLocalDisplayTimestamp(serializeAttempt(attempt));
  },
});

const REVIEW_LABELS = ["confirmed", "corrected", "ignored"];

export const updateReview = mutation({
  args: {
    id: v.id("recognitionAttempts"),
    expectedReviewVersion: v.optional(v.string()),
    reviewed: v.optional(v.boolean()),
    reviewedLabel: v.optional(v.string()),
    reviewedNote: v.optional(v.string()),
    reviewedAt: v.optional(v.string()),
  },
  returns: v.union(v.null(), v.object({
    id: v.id("recognitionAttempts"), timestamp: v.string(), timestamp_utc: v.optional(v.union(v.string(), v.null())), kiosk_id: v.string(),
    review_version: v.string(),
    source_attempt_id: v.union(v.string(), v.null()), face_detected: v.number(),
    candidate_worker_id: v.union(v.string(), v.null()), candidate_worker_name: v.union(v.string(), v.null()),
    best_score: v.union(v.number(), v.null()), second_best_score: v.union(v.number(), v.null()),
    score_margin: v.union(v.number(), v.null()), decision: v.string(), threshold: v.number(),
    liveness_confirmed: v.union(v.number(), v.null()), model_version: v.union(v.string(), v.null()),
    image_quality: v.union(v.number(), v.null()), face_quality: v.union(v.number(), v.null()),
    brightness: v.union(v.number(), v.null()), blur: v.union(v.number(), v.null()),
    reviewed: v.number(), reviewed_label: v.union(v.string(), v.null()),
    reviewed_note: v.union(v.string(), v.null()), reviewed_at: v.union(v.string(), v.null()),
    created_at: v.string(), updated_at: v.union(v.string(), v.null()),
  })),
  handler: async (ctx, args) => {
    const actor = await assertPortalRole(ctx, ["admin", "enrollment"]);
    const existing = await ctx.db.get(args.id);
    if (!existing) {
      throw new Error("Recognition attempt not found");
    }
    if (args.expectedReviewVersion !== reviewVersion(existing)) {
      throw new ConvexError({ code: "RECOGNITION_REVIEW_CONFLICT", message: REVIEW_CONFLICT_MESSAGE });
    }

    const reviewed = args.reviewed ?? true;
    const now = new Date().toISOString();
    const updates: Record<string, unknown> = {
      reviewed,
      updatedAt: now,
      reviewRevision: (existing.reviewRevision ?? 0) + 1,
    };
    if (args.reviewedLabel !== undefined) {
      const label = normalizeOptionalText(args.reviewedLabel);
      // Reads treat any other label as unreviewed, which would hide a "reviewed" attempt.
      if (label === undefined || !REVIEW_LABELS.includes(label)) {
        throw new ConvexError(`reviewedLabel must be one of ${REVIEW_LABELS.join(", ")}`);
      }
      updates.reviewedLabel = label;
    }
    if (args.reviewedNote !== undefined) {
      updates.reviewedNote = normalizeOptionalText(args.reviewedNote);
    }
    updates.reviewedAt = reviewed ? normalizeOptionalText(args.reviewedAt) || existing.reviewedAt || now : undefined;

    await ctx.db.patch(args.id, updates);
    await writeAuditLog(ctx, {
      actorUserId: actor.userId, action: "recognition.review", targetTable: "recognitionAttempts",
      targetId: args.id,
      details: JSON.stringify({ before: { updatedAt: existing.updatedAt ?? null, reviewedAt: existing.reviewedAt ?? null, reviewed: existing.reviewed, label: existing.reviewedLabel ?? null, note: existing.reviewedNote ?? null },
        after: { updatedAt: now, reviewedAt: updates.reviewedAt ?? null, reviewed, label: args.reviewedLabel === undefined ? existing.reviewedLabel ?? null : updates.reviewedLabel ?? null,
          note: args.reviewedNote === undefined ? existing.reviewedNote ?? null : updates.reviewedNote ?? null } }),
    });

    const updated = await ctx.db.get(args.id);
    return updated ? withFactoryLocalDisplayTimestamp(serializeAttempt(updated)) : null;
  },
});
