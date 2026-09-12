import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const closeoutFields = {
    date: v.string(),
    status: v.union(v.literal("open"), v.literal("completed"), v.literal("reopened")),
    supervisorName: v.optional(v.string()),
    notes: v.optional(v.string()),
    acknowledgedBlockers: v.boolean(),
    expected: v.float64(),
    present: v.float64(),
    late: v.float64(),
    missing: v.float64(),
    openExceptions: v.float64(),
    criticalExceptions: v.float64(),
    kioskWarnings: v.float64(),
    completedAt: v.optional(v.string()),
    reopenedAt: v.optional(v.string()),
    createdAt: v.string(),
    updatedAt: v.string(),
};

export default defineSchema({
  ...authTables,

  portalMembers: defineTable({
    userId: v.id("users"),
    role: v.union(v.literal("admin"), v.literal("enrollment"), v.literal("viewer")),
    active: v.boolean(),
    createdAt: v.string(),
    updatedAt: v.optional(v.string()),
  })
    .index("by_user", ["userId"])
    .index("by_active", ["active"]),

  workers: defineTable({
    name: v.string(),
    employeeId: v.optional(v.string()),
    department: v.string(),
    photoStorageIds: v.optional(v.array(v.id("_storage"))),
    faceEncoding: v.optional(v.array(v.float64())),
    enrolledAt: v.string(),
    updatedAt: v.optional(v.string()),
    active: v.boolean(),
    // ISO timestamp of the most recent biometric consent acknowledgement
    // captured at enrollment (refreshed on re-enrollment).
    consentAt: v.optional(v.string()),
    consentRecordedBy: v.optional(v.id("users")),
    // Set when an admin purged faceEncoding + photos; see RETENTION.md.
    biometricsPurgedAt: v.optional(v.string()),
  })
    .index("by_active", ["active"])
    .index("by_employee_id_and_active", ["employeeId", "active"]),

  // Append-only trail of privileged or privacy-relevant actions
  // (worker deactivation, biometric purge). Never edited or deleted.
  auditLog: defineTable({
    actorUserId: v.id("users"),
    action: v.string(),
    targetTable: v.string(),
    targetId: v.string(),
    reason: v.optional(v.string()),
    details: v.optional(v.string()),
    createdAt: v.string(),
  })
    .index("by_target", ["targetTable", "targetId"])
    .index("by_created", ["createdAt"]),

  attendance: defineTable({
    workerId: v.string(),
    eventType: v.string(),
    kioskId: v.optional(v.string()),
    timestamp: v.string(),
    idempotencyKey: v.optional(v.string()),
    synced: v.boolean(),
    workerName: v.optional(v.string()),
    confidence: v.optional(v.float64()),
    livenessConfirmed: v.optional(v.boolean()),
  }).index("by_timestamp", ["timestamp"])
    .index("by_worker", ["workerId"])
    .index("by_worker_and_timestamp", ["workerId", "timestamp"])
    .index("by_kiosk_and_idempotency_key", ["kioskId", "idempotencyKey"])
    .index("by_worker_timestamp_type_kiosk", ["workerId", "timestamp", "eventType", "kioskId"]),

  attendanceCorrections: defineTable({
    date: v.string(),
    workerId: v.string(),
    action: v.union(v.literal("add_clock_in"), v.literal("add_clock_out"), v.literal("void_event")),
    eventType: v.optional(v.union(v.literal("clock_in"), v.literal("clock_out"))),
    correctedTimestamp: v.optional(v.string()),
    originalAttendanceId: v.optional(v.id("attendance")),
    relatedExceptionKey: v.optional(v.string()),
    reason: v.string(),
    supervisorName: v.optional(v.string()),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("by_date", ["date"])
    .index("by_worker_date", ["workerId", "date"])
    .index("by_original_attendance", ["originalAttendanceId"]),

  recognitionAttempts: defineTable({
    timestamp: v.string(),
    kioskId: v.string(),
    sourceAttemptId: v.optional(v.string()),
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
    reviewed: v.boolean(),
    reviewedLabel: v.optional(v.string()),
    reviewedNote: v.optional(v.string()),
    reviewedAt: v.optional(v.string()),
    createdAt: v.string(),
    updatedAt: v.optional(v.string()),
  })
    .index("by_timestamp", ["timestamp"])
    .index("by_kiosk_timestamp", ["kioskId", "timestamp"])
    .index("by_reviewed_timestamp", ["reviewed", "timestamp"])
    .index("by_kiosk_reviewed_timestamp", ["kioskId", "reviewed", "timestamp"])
    .index("by_source_attempt_id", ["sourceAttemptId"]),

  exceptionReviews: defineTable({
    exceptionKey: v.string(),
    date: v.string(),
    type: v.string(),
    status: v.union(v.literal("open"), v.literal("reviewed"), v.literal("ignored"), v.literal("resolved")),
    note: v.optional(v.string()),
    reviewedAt: v.optional(v.string()),
    updatedAt: v.string(),
  })
    .index("by_key", ["exceptionKey"])
    .index("by_date", ["date"]),

  shiftCloseouts: defineTable(closeoutFields)
    .index("by_date", ["date"])
    .index("by_status", ["status"]),

  shiftCloseoutHistory: defineTable({
    closeoutId: v.id("shiftCloseouts"),
    actorUserId: v.id("users"),
    action: v.union(v.literal("complete"), v.literal("reopen")),
    occurredAt: v.string(),
    before: v.optional(v.object(closeoutFields)),
    after: v.object(closeoutFields),
  }).index("by_closeout", ["closeoutId"]),

  kiosks: defineTable({
    name: v.string(),
    kioskId: v.optional(v.string()),
    type: v.string(),
    location: v.string(),
    lastSync: v.optional(v.string()),
    // Self-reported device health, sent alongside each worker sync. A kiosk
    // whose network is up but whose camera/model is broken must not look
    // healthy on the dashboard.
    health: v.optional(v.object({
      cameraOk: v.optional(v.boolean()),
      modelOk: v.optional(v.boolean()),
      livenessAvailable: v.optional(v.boolean()),
      knownWorkers: v.optional(v.float64()),
      queuedLogs: v.optional(v.float64()),
      queuedAttempts: v.optional(v.float64()),
      degradedReason: v.optional(v.string()),
      lastScanAt: v.optional(v.string()),
      reportedAt: v.string(),
    })),
    active: v.boolean(),
  }).index("by_active", ["active"])
    .index("by_kiosk_id", ["kioskId"]),

  // One row per (kiosk, condition) episode, written by the alerting cron in
  // convex/alerts.ts. A row is "open" while resolvedAt is unset; a fresh
  // episode gets a new row once the previous one has resolved.
  alertState: defineTable({
    kioskId: v.string(),
    condition: v.string(),
    firstSeenAt: v.string(),
    lastNotifiedAt: v.optional(v.string()),
    resolvedAt: v.optional(v.string()),
  })
    .index("by_kiosk_condition", ["kioskId", "condition"])
    .index("by_resolved", ["resolvedAt"]),

  schedules: defineTable({
    name: v.string(),
    days: v.string(),
    startTime: v.string(),
    endTime: v.string(),
    department: v.optional(v.string()),
    active: v.boolean(),
    createdAt: v.string(),
  }).index("by_active", ["active"]),
});
