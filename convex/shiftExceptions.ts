import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { listEffectiveAttendanceByTimestampRange } from "./attendance";
import { createActiveKioskResolver } from "./kioskLookup";
import { listAllRecognitionAttemptsByFactoryDate } from "./recognitionAttempts";
import { assertPortalRole } from "./access";
import { getFactoryLocalDateKey, getFactoryLocalTimestamp } from "./localDate";

import { isSupportedScheduleTimeRange, SCHEDULE_TIME_ERROR } from "./scheduleTimes";

const LOW_MARGIN_THRESHOLD = 0.08;

type ExceptionStatus = "open" | "reviewed" | "ignored" | "resolved";
type ExceptionSeverity = "critical" | "warning" | "info";
type SuggestedResolutionAction =
  | "review_only"
  | "add_clock_in"
  | "add_clock_out"
  | "void_event"
  | "open_recognition_review";
type SuggestedResolution = {
  action: SuggestedResolutionAction;
  label: string;
  cta: string;
  reason: string;
  corrected_time: string | null;
  original_attendance_id: string | null;
  href: string | null;
  source_href: string | null;
  requires_worker: boolean;
  requires_original_event: boolean;
  can_apply: boolean;
  disabled_reason: string | null;
  source_exception_key: string;
};
type ShiftException = {
  key: string;
  date: string;
  type: string;
  severity: ExceptionSeverity;
  status: ExceptionStatus;
  title: string;
  description: string;
  worker_id: string | null;
  worker_name: string | null;
  department: string | null;
  kiosk_id: string | null;
  kiosk_name: string | null;
  first_seen: string | null;
  last_seen: string | null;
  schedule_name: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  event_count: number;
  attendance_id?: string | null;
  review_note: string | null;
  reviewed_at: string | null;
  suggested_resolution: SuggestedResolution;
  links: {
    activity_log?: string;
    worker?: string;
    recognition_lab?: string;
    kiosk?: string;
    schedules?: string;
  };
};

function getDayOfWeek(dateKey: string): number {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, day).getDay();
}

function getMinutesFromTime(value?: string | null): number | null {
  if (!value) return null;
  const match = value.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

function getMinutesFromTimestamp(timestamp?: string | null): number | null {
  if (!timestamp) return null;
  const match = timestamp.match(/T(\d{2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

// Compare both the day and scheduled deadline with the factory clock. A
// worker's last scan cannot tell us whether the shift has finished yet.
function scheduleTimeHasPassed(date: string, time: string, now: string) {
  if (getMinutesFromTime(time) === null) return false;
  return now > `${date}T${time}:00`;
}

function formatTime(value?: string | null) {
  return value || "not set";
}

function titleCase(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizeText(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function buildHref(path: string, params: Record<string, string | null | undefined>) {
  const query = Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] !== null && entry[1] !== undefined && entry[1] !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return query ? `${path}?${query}` : path;
}

function getActivityLogHref(date: string, workerId?: string | null, attendanceId?: string | null) {
  return buildHref("/log", {
    date,
    worker_id: workerId || null,
    attendance_id: attendanceId || null,
  });
}

function parseScheduleDays(days: string): number[] {
  try {
    const parsed = JSON.parse(days);
    return Array.isArray(parsed) ? parsed.filter((day) => Number.isInteger(day)) : [];
  } catch {
    return [];
  }
}

function getScheduleForWorker(worker: any, schedules: any[], dayOfWeek: number) {
  const todaysSchedules = schedules.filter((schedule) => parseScheduleDays(schedule.days).includes(dayOfWeek));
  const workerDepartment = String(worker.department || "").trim().toLowerCase();
  return (
    todaysSchedules.find(
      (schedule) => String(schedule.department || "").trim().toLowerCase() === workerDepartment,
    ) ||
    todaysSchedules.find((schedule) => !normalizeText(schedule.department)) ||
    null
  );
}

function getReviewStatus(review: any): ExceptionStatus {
  if (review?.status === "reviewed" || review?.status === "ignored" || review?.status === "resolved") {
    return review.status;
  }
  return "open";
}

function timeFromTimestamp(value?: string | null) {
  const match = value?.match(/T(\d{2}:\d{2})/);
  return match?.[1] || "";
}

function exceptionTypeLabel(type: string) {
  const labels: Record<string, string> = {
    missing_arrival: "Missing arrival",
    late_arrival: "Late arrival",
    missing_clock_out: "Still clocked in",
    scan_sequence: "Bad scan sequence",
    recognition_review: "Recognition review",
  };
  return labels[type] || titleCase(type);
}

function correctionReason(
  exception: Omit<ShiftException, "suggested_resolution">,
  action: "add_clock_in" | "add_clock_out" | "void_event",
  correctedTime?: string | null,
) {
  const worker = exception.worker_name || "Unknown worker";
  const issue = exceptionTypeLabel(exception.type);
  const schedule = exception.schedule_name ? ` on ${exception.schedule_name}` : "";
  const source = `Source exception ${exception.key}.`;

  if (action === "add_clock_in") {
    return `${issue}: supervisor verified ${worker}${schedule} should have a clock-in at ${correctedTime}. ${source}`;
  }

  if (action === "add_clock_out") {
    return `${issue}: supervisor verified ${worker}${schedule} should have a clock-out at ${correctedTime}. ${source}`;
  }

  const sourceEvent = exception.attendance_id ? ` source event ${exception.attendance_id}` : " selected source scan event";
  return `${issue}: supervisor verified ${worker}'s${sourceEvent} should be voided from effective attendance. ${source}`;
}

function reviewReason(exception: Omit<ShiftException, "suggested_resolution">, detail: string) {
  const issue = exceptionTypeLabel(exception.type);
  const worker = exception.worker_name || "Unknown worker";
  return `${issue}: ${detail} for ${worker}. Source exception ${exception.key}.`;
}

function suggestedResolutionBase(exception: Omit<ShiftException, "suggested_resolution">) {
  return {
    corrected_time: null,
    original_attendance_id: null,
    href: exception.links.activity_log || exception.links.recognition_lab || exception.links.kiosk || null,
    source_href: exception.links.activity_log || exception.links.recognition_lab || exception.links.kiosk || null,
    requires_worker: false,
    requires_original_event: false,
    can_apply: false,
    disabled_reason: null,
    source_exception_key: exception.key,
  };
}

function buildSuggestedResolution(exception: Omit<ShiftException, "suggested_resolution">): SuggestedResolution {
  const base = suggestedResolutionBase(exception);
  const workerMissing = !exception.worker_id;
  const workerDisabledReason = "A worker-backed exception is required before an attendance correction can be created.";

  if (exception.type === "unsupported_schedule") {
    return { ...base, action: "review_only", label: "Fix schedule", cta: "Open schedules",
      reason: SCHEDULE_TIME_ERROR, href: exception.links.schedules || null,
      source_href: exception.links.schedules || null, disabled_reason: SCHEDULE_TIME_ERROR };
  }

  if (exception.type === "missing_arrival") {
    const correctedTime = exception.scheduled_start || "06:00";
    return {
      ...base,
      action: "add_clock_in",
      label: "Add missing clock-in",
      cta: "Correct attendance",
      reason: correctionReason(exception, "add_clock_in", correctedTime),
      corrected_time: correctedTime,
      href: null,
      requires_worker: true,
      can_apply: !workerMissing,
      disabled_reason: workerMissing ? workerDisabledReason : null,
    };
  }

  if (exception.type === "missing_clock_out") {
    const correctedTime = exception.scheduled_end || timeFromTimestamp(exception.last_seen) || "14:30";
    return {
      ...base,
      action: "add_clock_out",
      label: "Add missing clock-out",
      cta: "Correct attendance",
      reason: correctionReason(exception, "add_clock_out", correctedTime),
      corrected_time: correctedTime,
      href: null,
      requires_worker: true,
      can_apply: !workerMissing,
      disabled_reason: workerMissing ? workerDisabledReason : null,
    };
  }

  if (exception.type === "scan_sequence") {
    if (!exception.attendance_id) {
      return {
        ...base,
        action: "review_only",
        label: "Review scan sequence",
        cta: "Review source",
        reason: reviewReason(exception, "scan sequence has no raw attendance row to void automatically"),
        requires_worker: true,
        requires_original_event: true,
        disabled_reason: "No original attendance event is available to void; review the source scans before deciding on a correction.",
      };
    }

    return {
      ...base,
      action: "void_event",
      label: "Void mistaken scan",
      cta: "Correct attendance",
      reason: correctionReason(exception, "void_event"),
      corrected_time: timeFromTimestamp(exception.last_seen || exception.first_seen) || null,
      original_attendance_id: exception.attendance_id,
      href: null,
      requires_worker: true,
      requires_original_event: true,
      can_apply: !workerMissing,
      disabled_reason: workerMissing ? workerDisabledReason : null,
    };
  }

  if (exception.type === "late_arrival") {
    return {
      ...base,
      action: "review_only",
      label: "Review late arrival",
      cta: "Review source",
      reason: reviewReason(exception, "late arrival preserves the kiosk clock-in and should be reviewed without rewriting raw evidence"),
      href: exception.links.activity_log || null,
      disabled_reason: "Late arrivals use the kiosk clock-in as evidence; add an audited correction only if separate evidence proves a missing scan.",
    };
  }

  if (exception.type === "recognition_review") {
    return {
      ...base,
      action: "open_recognition_review",
      label: "Open recognition review",
      cta: "Open Recognition Lab",
      reason: reviewReason(exception, "supervisor should review the linked recognition attempt before changing attendance"),
      href: exception.links.recognition_lab || null,
      source_href: exception.links.recognition_lab || exception.links.activity_log || null,
      disabled_reason: exception.links.recognition_lab ? null : "No exact recognition attempt link is available; review the recognition backlog manually.",
    };
  }

  return {
    ...base,
    action: "review_only",
    label: "Review exception",
    cta: "Review source",
    reason: reviewReason(exception, "unknown exception type requires supervisor review before any audited correction"),
    disabled_reason: "This exception type does not have a one-tap audited correction path.",
  };
}

function withReview(exception: ShiftException, review: any): ShiftException {
  return {
    ...exception,
    status: getReviewStatus(review),
    review_note: review?.note || null,
    reviewed_at: review?.reviewedAt || null,
  };
}

function createException(input: Omit<ShiftException, "status" | "review_note" | "reviewed_at" | "suggested_resolution">): ShiftException {
  const exception: Omit<ShiftException, "suggested_resolution"> = {
    ...input,
    status: "open",
    review_note: null,
    reviewed_at: null,
  };
  return {
    ...exception,
    suggested_resolution: buildSuggestedResolution(exception),
  };
}

function summarize(exceptions: ShiftException[]) {
  const open = exceptions.filter((exception) => exception.status === "open");
  const bySeverity = { critical: 0, warning: 0, info: 0 };
  const byType: Record<string, number> = {};
  const byStatus = { open: 0, reviewed: 0, ignored: 0, resolved: 0 };

  for (const exception of exceptions) {
    bySeverity[exception.severity] += 1;
    byType[exception.type] = (byType[exception.type] || 0) + 1;
    byStatus[exception.status] += 1;
  }

  return {
    total: exceptions.length,
    open: open.length,
    critical: open.filter((exception) => exception.severity === "critical").length,
    warning: open.filter((exception) => exception.severity === "warning").length,
    info: open.filter((exception) => exception.severity === "info").length,
    by_severity: bySeverity,
    by_type: byType,
    by_status: byStatus,
  };
}

export async function buildShiftExceptions(ctx: any, date: string) {
  const dayOfWeek = getDayOfWeek(date);
  const factoryNow = getFactoryLocalTimestamp(new Date().toISOString())!;
  const [workers, attendance, schedules, reviews, recognitionAttempts] = await Promise.all([
    ctx.db
      .query("workers")
      .withIndex("by_active", (q: any) => q.eq("active", true))
      .collect(),
    listEffectiveAttendanceByTimestampRange(ctx, date),
    ctx.db
      .query("schedules")
      .withIndex("by_active", (q: any) => q.eq("active", true))
      .collect(),
    ctx.db
      .query("exceptionReviews")
      .withIndex("by_date", (q: any) => q.eq("date", date))
      .collect(),
    listAllRecognitionAttemptsByFactoryDate(ctx, { date }),
  ]);

  const reviewsByKey = new Map(reviews.map((review: any) => [review.exceptionKey, review]));
  const eventsByWorker = new Map<string, any[]>();
  const exceptions: ShiftException[] = [];

  for (const event of attendance) {
    const events = eventsByWorker.get(event.workerId) || [];
    events.push(event);
    eventsByWorker.set(event.workerId, events);
  }

  for (const worker of workers) {
    let schedule = getScheduleForWorker(worker, schedules, dayOfWeek);
    const workerId = String(worker._id);
    const workerEvents = eventsByWorker.get(workerId) || []; // Already chronological.
    const clockIns = workerEvents.filter((event) => event.eventType === "clock_in");
    const clockOuts = workerEvents.filter((event) => event.eventType === "clock_out");
    const firstIn = clockIns[0] || null;
    const lastEvent = workerEvents[workerEvents.length - 1] || null;
    const lastOut = clockOuts[clockOuts.length - 1] || null;
    const workerName = worker.name || "Unknown worker";
    const department = worker.department || null;
    const baseLinks = {
      activity_log: getActivityLogHref(date, workerId),
      worker: `/workers`,
      schedules: "/schedules",
    };

    if (schedule && !isSupportedScheduleTimeRange(schedule.startTime, schedule.endTime)) {
      exceptions.push(createException({
        key: `${date}:unsupported_schedule:${workerId}`,
        date, type: "unsupported_schedule", severity: "critical",
        title: `${workerName} has an unsupported schedule`,
        description: `${schedule.name}: ${SCHEDULE_TIME_ERROR} Schedule-based attendance checks are unavailable until an administrator fixes the schedule.`,
        worker_id: workerId, worker_name: workerName, department,
        kiosk_id: null, kiosk_name: null,
        first_seen: firstIn?.timestamp || null, last_seen: lastEvent?.timestamp || null,
        schedule_name: schedule.name, scheduled_start: schedule.startTime, scheduled_end: schedule.endTime,
        event_count: workerEvents.length, links: baseLinks,
      }));
      // Keep scan-based checks, but never suggest a same-day correction from this range.
      schedule = null;
    }

    if (schedule && !firstIn && scheduleTimeHasPassed(date, schedule.startTime, factoryNow)) {
      const key = `${date}:missing_arrival:${workerId}`;
      exceptions.push(createException({
        key,
        date,
        type: "missing_arrival",
        severity: "critical",
        title: `${workerName} has not arrived`,
        description: `${workerName} is expected for ${schedule.name} starting at ${formatTime(schedule.startTime)}, but has no clock-in scan.`,
        worker_id: workerId,
        worker_name: workerName,
        department,
        kiosk_id: null,
        kiosk_name: null,
        first_seen: null,
        last_seen: null,
        schedule_name: schedule.name,
        scheduled_start: schedule.startTime,
        scheduled_end: schedule.endTime,
        event_count: 0,
        attendance_id: null,
        links: baseLinks,
      }));
    }

    if (schedule && firstIn) {
      const startMinutes = getMinutesFromTime(schedule.startTime);
      const firstInMinutes = getMinutesFromTimestamp(firstIn.timestamp);
      if (startMinutes !== null && firstInMinutes !== null && firstInMinutes > startMinutes) {
        const key = `${date}:late_arrival:${workerId}`;
        exceptions.push(createException({
          key,
          date,
          type: "late_arrival",
          severity: firstInMinutes - startMinutes >= 30 ? "critical" : "warning",
          title: `${workerName} arrived late`,
          description: `${workerName} clocked in at ${firstIn.timestamp.slice(11, 16)}, after the ${formatTime(schedule.startTime)} scheduled start.`,
          worker_id: workerId,
          worker_name: workerName,
          department,
          kiosk_id: firstIn.kioskId || null,
          kiosk_name: null,
          first_seen: firstIn.timestamp,
          last_seen: firstIn.timestamp,
          schedule_name: schedule.name,
          scheduled_start: schedule.startTime,
          scheduled_end: schedule.endTime,
          event_count: clockIns.length,
          attendance_id: String(firstIn._id).startsWith("correction:") ? null : String(firstIn._id),
          links: {
            ...baseLinks,
            activity_log: getActivityLogHref(date, workerId, String(firstIn._id).startsWith("correction:") ? null : String(firstIn._id)),
          },
        }));
      }
    }

    if (schedule && lastEvent?.eventType === "clock_in") {
      const shouldFlagMissingClockOut = scheduleTimeHasPassed(date, schedule.endTime, factoryNow);
      if (shouldFlagMissingClockOut) {
        const key = `${date}:missing_clock_out:${workerId}`;
        exceptions.push(createException({
          key,
          date,
          type: "missing_clock_out",
          severity: "warning",
          title: `${workerName} is still clocked in`,
          description: `${workerName} last scanned in at ${lastEvent.timestamp.slice(11, 16)} and has no clock-out after the ${formatTime(schedule.endTime)} scheduled end.`,
          worker_id: workerId,
          worker_name: workerName,
          department,
          kiosk_id: lastEvent.kioskId || null,
          kiosk_name: null,
          first_seen: firstIn?.timestamp || lastEvent.timestamp,
          last_seen: lastEvent.timestamp,
          schedule_name: schedule.name,
          scheduled_start: schedule.startTime,
          scheduled_end: schedule.endTime,
          event_count: workerEvents.length,
          attendance_id: String(lastEvent._id).startsWith("correction:") ? null : String(lastEvent._id),
          links: {
            ...baseLinks,
            activity_log: getActivityLogHref(date, workerId, String(lastEvent._id).startsWith("correction:") ? null : String(lastEvent._id)),
          },
        }));
      }
    }

    for (let index = 0; index < workerEvents.length; index += 1) {
      const event = workerEvents[index];
      const previous = workerEvents[index - 1];
      const repeated = previous && previous.eventType === event.eventType;
      const firstEventIsOut = index === 0 && event.eventType === "clock_out";
      if (!repeated && !firstEventIsOut) continue;

      // Use the source ID, including synthetic correction IDs: independent scans
      // can share a timestamp and type. Timestamp-only legacy reviews cannot be
      // safely attributed after later scans/corrections, so they are not reused.
      const key = `${date}:scan_sequence:${workerId}:${event._id}`;
      exceptions.push(createException({
        key,
        date,
        type: "scan_sequence",
        severity: firstEventIsOut ? "critical" : "warning",
        title: `${workerName} has a scan sequence issue`,
        description: firstEventIsOut
          ? `${workerName} clocked out without a prior clock-in scan today.`
          : `${workerName} has repeated ${event.eventType.replace("_", " ")} scans without the opposite event between them.`,
        worker_id: workerId,
        worker_name: workerName,
        department,
        kiosk_id: event.kioskId || null,
        kiosk_name: null,
        first_seen: previous?.timestamp || event.timestamp,
        last_seen: event.timestamp,
        schedule_name: schedule?.name || null,
        scheduled_start: schedule?.startTime || null,
        scheduled_end: schedule?.endTime || null,
        event_count: workerEvents.length,
        attendance_id: String(event._id).startsWith("correction:") ? null : String(event._id),
        links: {
          ...baseLinks,
          activity_log: getActivityLogHref(date, workerId, String(event._id).startsWith("correction:") ? null : String(event._id)),
        },
      }));
    }
  }

  const resolveKiosk = createActiveKioskResolver(ctx);
  const kioskNameCache = new Map<string, string | null>();
  async function resolveKioskName(kioskId?: string | null) {
    if (!kioskId) return null;
    if (kioskNameCache.has(kioskId)) return kioskNameCache.get(kioskId) || null;
    const kiosk = await resolveKiosk(kioskId);
    const name = kiosk?.name || null;
    kioskNameCache.set(kioskId, name);
    return name;
  }

  function recognitionText(attempt: any, serializedKey: string, rawKey: string) {
    return normalizeText(attempt?.[serializedKey]) || normalizeText(attempt?.[rawKey]) || null;
  }

  function recognitionNumber(attempt: any, serializedKey: string, rawKey: string) {
    const serializedValue = attempt?.[serializedKey];
    if (typeof serializedValue === "number" && Number.isFinite(serializedValue)) return serializedValue;
    const rawValue = attempt?.[rawKey];
    if (typeof rawValue === "number" && Number.isFinite(rawValue)) return rawValue;
    return null;
  }

  function recognitionReviewed(attempt: any) {
    return attempt?.reviewed === true || attempt?.reviewed === 1;
  }

  for (const attempt of recognitionAttempts) {
    const decision = String(attempt.decision || "unknown");
    const scoreMargin = recognitionNumber(attempt, "score_margin", "scoreMargin");
    const kioskId = recognitionText(attempt, "kiosk_id", "kioskId");
    const candidateWorkerId = recognitionText(attempt, "candidate_worker_id", "candidateWorkerId");
    const candidateWorkerName = recognitionText(attempt, "candidate_worker_name", "candidateWorkerName");
    const reviewed = recognitionReviewed(attempt);
    const lowMarginAccepted = decision.startsWith("accepted") && scoreMargin !== null && scoreMargin <= LOW_MARGIN_THRESHOLD;
    const riskyDecision =
      decision === "near_miss" ||
      decision === "rejected_unknown" ||
      decision === "unknown" ||
      decision.startsWith("rejected");
    const attemptId = String(attempt.id || attempt._id);
    const key = `${date}:recognition_review:${attemptId}`;
    const label = recognitionText(attempt, "reviewed_label", "reviewedLabel") || "confirmed";
    const completed = reviewed && ["confirmed", "corrected", "ignored"].includes(label);
    const attemptReviewedAt = recognitionText(attempt, "reviewed_at", "reviewedAt");
    const attemptUpdatedAt = recognitionText(attempt, "updated_at", "updatedAt") || attemptReviewedAt;
    const explicitReview = reviewsByKey.get(key) as { updatedAt: string } | undefined;
    // Both screens can review or reopen an exception. The latest action wins;
    // an old exception disposition must not undo a newer Recognition Lab review.
    const explicitIsNewer = explicitReview && (
      !attemptUpdatedAt || Date.parse(explicitReview.updatedAt) > Date.parse(attemptUpdatedAt)
    );
    if (!explicitIsNewer) {
      reviewsByKey.set(key, {
        status: completed ? (label === "ignored" ? "ignored" : "reviewed") : "open",
        note: recognitionText(attempt, "reviewed_note", "reviewedNote"),
        reviewedAt: completed ? attemptReviewedAt : null,
      });
    }
    if (completed && !lowMarginAccepted && !riskyDecision && !explicitReview) continue;
    const candidate = candidateWorkerName || "Unknown person";
    const kioskName = await resolveKioskName(kioskId);
    exceptions.push(createException({
      key,
      date,
      type: "recognition_review",
      severity: decision === "near_miss" || lowMarginAccepted ? "warning" : "info",
      title: `${candidate} needs recognition review`,
      description: `${decision.replace(/_/g, " ")} at ${kioskId || "unknown kiosk"}${scoreMargin !== null ? ` with ${scoreMargin.toFixed(3)} score margin` : ""}.`,
      worker_id: candidateWorkerId,
      worker_name: candidateWorkerName,
      department: null,
      kiosk_id: kioskId,
      kiosk_name: kioskName,
      first_seen: attempt.timestamp,
      last_seen: attempt.timestamp,
      schedule_name: null,
      scheduled_start: null,
      scheduled_end: null,
      event_count: 1,
      attendance_id: null,
      links: {
        activity_log: getActivityLogHref(date, candidateWorkerId),
        recognition_lab: buildHref("/calibration/recognition", {
          date,
          review_status: "all",
          attempt_id: attemptId,
        }),
        kiosk: "/kiosks",
      },
    }));
  }

  const hydrated = exceptions.map((exception) => withReview(exception, reviewsByKey.get(exception.key)));
  hydrated.sort((a, b) => {
    const severityOrder = { critical: 0, warning: 1, info: 2 };
    const statusOrder = { open: 0, reviewed: 1, resolved: 2, ignored: 3 };
    return (
      statusOrder[a.status] - statusOrder[b.status] ||
      severityOrder[a.severity] - severityOrder[b.severity] ||
      (a.first_seen || "").localeCompare(b.first_seen || "") ||
      a.title.localeCompare(b.title)
    );
  });

  return hydrated;
}

export const summary = query({
  args: { date: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await assertPortalRole(ctx, ["admin", "enrollment", "viewer"]);
    const date = args.date || getFactoryLocalDateKey(new Date().toISOString())!;
    const exceptions = await buildShiftExceptions(ctx, date);
    return {
      date,
      generated_at: new Date().toISOString(),
      exceptions,
      summary: summarize(exceptions),
    };
  },
});

export const review = mutation({
  args: {
    exceptionKey: v.string(),
    date: v.string(),
    type: v.string(),
    status: v.union(v.literal("open"), v.literal("reviewed"), v.literal("ignored"), v.literal("resolved")),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await assertPortalRole(ctx, ["admin", "enrollment"]);
    const now = new Date().toISOString();
    const existing = await ctx.db
      .query("exceptionReviews")
      .withIndex("by_key", (q) => q.eq("exceptionKey", args.exceptionKey))
      .first();
    const patch = {
      date: args.date,
      type: args.type,
      status: args.status,
      note: normalizeText(args.note),
      reviewedAt: args.status === "open" ? undefined : now,
      updatedAt: now,
    };

    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return { id: existing._id, ...patch };
    }

    const id = await ctx.db.insert("exceptionReviews", {
      exceptionKey: args.exceptionKey,
      ...patch,
    });
    return { id, exceptionKey: args.exceptionKey, ...patch };
  },
});
