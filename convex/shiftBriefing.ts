import { getFactoryLocalDateKey } from "./localDate";
import { query } from "./_generated/server";
import { v } from "convex/values";
import { listEffectiveAttendanceByTimestampRange } from "./attendance";
import { buildShiftExceptions } from "./shiftExceptions";
import { assertPortalRole } from "./access";

type WorkerCoverageStatus = "present" | "late" | "missing" | "clocked_out" | "still_clocked_in";
type DepartmentCoverageStatus = "covered" | "short" | "critical" | "unscheduled";
type ActionPriority = "critical" | "warning" | "info";
type KioskStatus = "online" | "stale" | "offline" | "never_synced";
type ShiftTrustBriefStatus = "ready" | "attention" | "blocked";
type ShiftTrustRiskCategory = "kiosk" | "enrollment" | "schedule" | "exception" | "correction" | "attendance";

type ShiftTrustRisk = {
  id: string;
  category: ShiftTrustRiskCategory;
  severity: ActionPriority;
  label: string;
  description: string;
  count: number;
  href: string;
  exact: boolean;
};

const ONLINE_THRESHOLD_MS = 15 * 60 * 1000;
const STALE_THRESHOLD_MS = 60 * 60 * 1000;
// Kiosks match exclusively 512-dim MobileFaceNet embeddings.
const SUPPORTED_ENCODING_LENGTHS = new Set([512]);

function getDayOfWeek(dateKey: string): number {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, day).getDay();
}

function getMinutesFromTime(value?: string | null): number | null {
  if (!value) return null;
  const match = value.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function getMinutesFromTimestamp(timestamp?: string | null): number | null {
  if (!timestamp) return null;
  const match = timestamp.match(/T(\d{2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function parseScheduleDays(days: string): number[] {
  try {
    const parsed = JSON.parse(days);
    return Array.isArray(parsed) ? parsed.filter((day) => Number.isInteger(day)) : [];
  } catch {
    return [];
  }
}

function normalizeText(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed || "";
}

function getEncodingStatus(encoding?: number[]) {
  if (!encoding || encoding.length === 0) return "missing";
  return SUPPORTED_ENCODING_LENGTHS.has(encoding.length) && encoding.every((value) => Number.isFinite(value))
    ? "valid"
    : "invalid";
}

function getScheduleForWorker(worker: any, schedules: any[], dayOfWeek: number) {
  const todaysSchedules = schedules.filter((schedule) => parseScheduleDays(schedule.days).includes(dayOfWeek));
  const workerDepartment = normalizeText(worker.department).toLowerCase();
  return (
    todaysSchedules.find(
      (schedule) => normalizeText(schedule.department).toLowerCase() === workerDepartment,
    ) ||
    todaysSchedules.find((schedule) => !normalizeText(schedule.department)) ||
    null
  );
}

function getKioskStatus(lastSync?: string | null): KioskStatus {
  if (!lastSync) return "never_synced";
  const ageMs = Date.now() - new Date(lastSync).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return "online";
  if (ageMs <= ONLINE_THRESHOLD_MS) return "online";
  if (ageMs <= STALE_THRESHOLD_MS) return "stale";
  return "offline";
}

function actionRank(priority: ActionPriority) {
  return { critical: 0, warning: 1, info: 2 }[priority];
}

function getCoverageActionStatus(row: any): WorkerCoverageStatus {
  if (row.missing > 0) return "missing";
  if (row.late > 0) return "late";
  return "clocked_out";
}

function getExceptionIntent(exception: any) {
  if (!exception.worker_id) return undefined;
  if (exception.type === "scan_sequence") return exception.attendance_id ? "correct" : undefined;
  return exception.type === "missing_arrival" || exception.type === "missing_clock_out" ? "correct" : undefined;
}

function getRecognitionReviewPriority(exceptions: any[]): ActionPriority {
  if (exceptions.some((exception) => exception.severity === "critical")) return "critical";
  return exceptions.some((exception) => exception.severity === "warning") ? "warning" : "info";
}

function getRecognitionReviewHref(date: string, exceptions: any[]) {
  const [exception] = exceptions;
  return buildHref("/exceptions", {
    date,
    status: "open",
    type: "recognition_review",
    severity: exceptions.length === 1 ? exception?.severity : undefined,
    exception_key: exceptions.length === 1 ? exception?.key : undefined,
  });
}

function plural(count: number, singular: string, pluralValue?: string) {
  return `${count} ${count === 1 ? singular : pluralValue || `${singular}s`}`;
}

function getPrimaryActionSourceLabel(action: any) {
  if (String(action.id || "").startsWith("coverage:")) return "Schedule and effective attendance";
  if (String(action.id || "").startsWith("kiosk:")) return "Kiosk sync evidence";
  if (String(action.id || "").startsWith("recognition:")) return "Recognition review exceptions";
  if (String(action.id || "").startsWith("schedules:")) return "Active schedule coverage";
  if (action.href?.startsWith("/exceptions")) return "Open shift exceptions";
  return "Shift briefing evidence";
}

function hrefHasExactSource(href?: string | null) {
  return Boolean(href && (href.includes("exception_key=") || href.includes("attendance_id=") || href.includes("worker_id=")));
}

function getPrimaryActionProofLabel(action: any) {
  if (hrefHasExactSource(action.href)) return "Exact source row";
  if (action.href?.startsWith("/exceptions")) return "Filtered exception queue";
  if (action.href?.startsWith("/briefing")) return "Filtered briefing view";
  if (action.href === "/kiosks") return "Kiosk trust record";
  if (action.href === "/schedules") return "Schedule setup";
  return "Source view";
}

function risk(
  id: string,
  category: ShiftTrustRiskCategory,
  severity: ActionPriority,
  label: string,
  description: string,
  count: number,
  href: string,
  exact = false,
): ShiftTrustRisk {
  return { id, category, severity, label, description, count, href, exact };
}

// Self-reported device faults that stop a kiosk from scanning even while its
// network sync stays green. liveness_unavailable is deliberately excluded:
// blink verification is optional and the kiosk still records clock events.
const SCAN_BLOCKING_DEGRADED_REASONS = new Set([
  "camera_error",
  "model_error",
  "encoding_mismatch",
  "no_workers_synced",
]);

function hasScanBlockingDeviceFault(health: any): boolean {
  if (!health) return false;
  if (health.cameraOk === false || health.modelOk === false) return true;
  return typeof health.degradedReason === "string" && SCAN_BLOCKING_DEGRADED_REASONS.has(health.degradedReason);
}

function buildShiftTrustBrief(input: {
  date: string;
  generatedAt: string;
  summary: {
    expected: number;
    present: number;
    late: number;
    missing: number;
    open_exceptions: number;
    recognition_reviews: number;
    kiosk_warnings: number;
  };
  actionItems: any[];
  todaysSchedules: any[];
  workers: any[];
  openExceptions: any[];
  criticalExceptions: any[];
  missingClockOuts: any[];
  recognitionReviews: any[];
  kioskCounts: Record<KioskStatus, number>;
  // All kiosks reporting a scan-blocking fault (drives blockers/severity)…
  deviceFaultKiosks: number;
  // …vs. only those not already counted as stale/offline warnings (count math).
  deviceFaultWarningKiosks: number;
  attendanceCorrections: any[];
}) {
  const invalidEnrollment = input.workers.filter((worker) => getEncodingStatus(worker.faceEncoding) === "invalid");
  const missingEnrollment = input.workers.filter((worker) => getEncodingStatus(worker.faceEncoding) === "missing");
  const offlineKioskWarnings = input.kioskCounts.offline + input.kioskCounts.never_synced;
  const staleKioskWarnings = input.kioskCounts.stale;
  const firstCriticalException = input.criticalExceptions.find((exception) => exception.key);
  const firstMissingClockOut = input.missingClockOuts.find((exception) => exception.key);
  const firstRecognitionReview = input.recognitionReviews.find((exception) => exception.key);
  const firstInvalidEnrollmentWorker = invalidEnrollment.find((worker) => worker._id);
  const firstMissingEnrollmentWorker = missingEnrollment.find((worker) => worker._id);

  const readinessBlockers: ShiftTrustRisk[] = [];
  if (input.todaysSchedules.length === 0) {
    readinessBlockers.push(risk(
      "schedule:none-today",
      "schedule",
      "warning",
      "No active schedule today",
      "Shift trust cannot be calculated until a schedule includes this date.",
      1,
      "/schedules",
    ));
  }
  if (input.summary.missing > 0) {
    readinessBlockers.push(risk(
      "attendance:missing-arrivals",
      "attendance",
      "critical",
      "Expected workers missing",
      `${plural(input.summary.missing, "scheduled worker")} have no clock-in scan yet.`,
      input.summary.missing,
      buildHref("/briefing", { date: input.date, status: "missing" }),
    ));
  }
  if (offlineKioskWarnings > 0) {
    readinessBlockers.push(risk(
      "kiosk:offline",
      "kiosk",
      "critical",
      "Kiosk sync is blocking trust",
      `${plural(offlineKioskWarnings, "kiosk")} are offline or have never synced.`,
      offlineKioskWarnings,
      "/kiosks",
    ));
  }
  if (input.deviceFaultKiosks > 0) {
    readinessBlockers.push(risk(
      "kiosk:device-fault",
      "kiosk",
      "critical",
      "Kiosk hardware faults block scanning",
      `${plural(input.deviceFaultKiosks, "kiosk")} report a camera, model, or roster fault that prevents face scans.`,
      input.deviceFaultKiosks,
      "/kiosks",
    ));
  }
  if (invalidEnrollment.length > 0) {
    readinessBlockers.push(risk(
      "enrollment:invalid-face-data",
      "enrollment",
      "critical",
      "Invalid face data blocks clock-in confidence",
      `${plural(invalidEnrollment.length, "worker")} need re-enrollment before kiosk recognition can be trusted.`,
      invalidEnrollment.length,
      buildHref("/enroll", { worker_id: firstInvalidEnrollmentWorker ? String(firstInvalidEnrollmentWorker._id) : null }),
      Boolean(firstInvalidEnrollmentWorker?._id),
    ));
  }
  if (input.criticalExceptions.length > 0) {
    readinessBlockers.push(risk(
      "exception:critical",
      "exception",
      "critical",
      "Critical exceptions are open",
      `${plural(input.criticalExceptions.length, "critical exception")} need supervisor review.`,
      input.criticalExceptions.length,
      buildHref("/exceptions", {
        date: input.date,
        status: "open",
        severity: "critical",
        exception_key: firstCriticalException?.key,
      }),
      Boolean(firstCriticalException?.key),
    ));
  }

  const closeoutRisks: ShiftTrustRisk[] = [];
  if (input.missingClockOuts.length > 0) {
    closeoutRisks.push(risk(
      "closeout:missing-clock-outs",
      "attendance",
      "warning",
      "Missing clock-outs need review",
      `${plural(input.missingClockOuts.length, "missing clock-out exception")} remain open.`,
      input.missingClockOuts.length,
      buildHref("/exceptions", {
        date: input.date,
        status: "open",
        type: "missing_clock_out",
        exception_key: firstMissingClockOut?.key,
        intent: firstMissingClockOut?.key ? "correct" : null,
      }),
      Boolean(firstMissingClockOut?.key),
    ));
  }
  if (input.recognitionReviews.length > 0) {
    closeoutRisks.push(risk(
      "closeout:recognition-reviews",
      "exception",
      getRecognitionReviewPriority(input.recognitionReviews),
      "Recognition reviews remain open",
      `${plural(input.recognitionReviews.length, "recognition review")} remain open before closeout trust is clean.`,
      input.recognitionReviews.length,
      getRecognitionReviewHref(input.date, input.recognitionReviews),
      Boolean(firstRecognitionReview?.key),
    ));
  }
  const totalKioskWarnings = staleKioskWarnings + offlineKioskWarnings + input.deviceFaultWarningKiosks;
  if (totalKioskWarnings > 0) {
    closeoutRisks.push(risk(
      "closeout:kiosk-warnings",
      "kiosk",
      offlineKioskWarnings + input.deviceFaultKiosks > 0 ? "critical" : "warning",
      "Kiosk warnings affect closeout trust",
      `${plural(totalKioskWarnings, "kiosk warning")} may affect today’s attendance confidence.`,
      totalKioskWarnings,
      "/kiosks",
    ));
  }
  if (input.openExceptions.length > 0) {
    closeoutRisks.push(risk(
      "closeout:open-exceptions",
      "exception",
      input.criticalExceptions.length > 0 ? "critical" : "warning",
      "Open exceptions need disposition",
      `${plural(input.openExceptions.length, "open exception")} need review or acknowledgement before closeout.`,
      input.openExceptions.length,
      buildHref("/exceptions", { date: input.date, status: "open" }),
    ));
  }
  if (input.attendanceCorrections.length > 0) {
    closeoutRisks.push(risk(
      "closeout:attendance-corrections",
      "correction",
      "info",
      "Corrections are part of today’s audit trail",
      `${plural(input.attendanceCorrections.length, "attendance correction")} are recorded for this shift.`,
      input.attendanceCorrections.length,
      buildHref("/log", { date: input.date }),
    ));
  }
  if (missingEnrollment.length > 0) {
    closeoutRisks.push(risk(
      "closeout:missing-face-data",
      "enrollment",
      "warning",
      "Enrollment gaps may cause tomorrow’s exceptions",
      `${plural(missingEnrollment.length, "worker")} are missing face data for kiosk recognition.`,
      missingEnrollment.length,
      buildHref("/enroll", { worker_id: firstMissingEnrollmentWorker ? String(firstMissingEnrollmentWorker._id) : null }),
      Boolean(firstMissingEnrollmentWorker?._id),
    ));
  }

  const hasCriticalBlocker = readinessBlockers.some((item) => item.severity === "critical");
  const readinessStatus: ShiftTrustBriefStatus = hasCriticalBlocker
    ? "blocked"
    : readinessBlockers.length > 0 || closeoutRisks.some((item) => item.severity !== "info") || input.summary.late > 0
      ? "attention"
      : "ready";
  const statusLead = readinessStatus === "ready"
    ? "Morning readiness is ready"
    : readinessStatus === "blocked"
      ? "Morning readiness is blocked"
      : "Morning readiness needs attention";
  const summarySentence = `${statusLead}: ${input.summary.present}/${input.summary.expected} expected workers are present, ${input.summary.late} late, ${input.summary.missing} missing, ${input.summary.open_exceptions} open exceptions, and ${input.summary.kiosk_warnings} kiosk warnings.`;
  const primaryAction = input.actionItems[0]
    ? {
        ...input.actionItems[0],
        cta: input.actionItems[0].priority === "critical" ? "Open first action" : "Review first action",
        source_label: getPrimaryActionSourceLabel(input.actionItems[0]),
        proof_label: getPrimaryActionProofLabel(input.actionItems[0]),
        exact: hrefHasExactSource(input.actionItems[0].href),
      }
    : null;

  return {
    readiness_status: readinessStatus,
    summary_sentence: summarySentence,
    primary_action: primaryAction,
    readiness_blockers: readinessBlockers,
    closeout_risks: closeoutRisks,
    source_counts: {
      expected: input.summary.expected,
      present: input.summary.present,
      late: input.summary.late,
      missing: input.summary.missing,
      open_exceptions: input.summary.open_exceptions,
      critical_exceptions: input.criticalExceptions.length,
      recognition_reviews: input.recognitionReviews.length,
      missing_clock_outs: input.missingClockOuts.length,
      corrections: input.attendanceCorrections.length,
      kiosk_warnings: input.summary.kiosk_warnings,
    },
    generated_at: input.generatedAt,
    freshness: {
      label: "Generated from current briefing evidence",
      generated_at: input.generatedAt,
    },
    source_labels: [
      "Active workers",
      "Active schedules",
      "Effective attendance",
      "Kiosk sync records",
      "Open shift exceptions",
      "Attendance corrections",
      "Ranked briefing actions",
    ],
  };
}

function buildHref(path: string, params: Record<string, string | null | undefined>) {
  const query = Object.entries(params)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return query ? `${path}?${query}` : path;
}

function getWorkerStatus(input: {
  schedule: any;
  firstIn: any | null;
  lastEvent: any | null;
}): WorkerCoverageStatus {
  if (!input.firstIn) return "missing";
  const startMinutes = getMinutesFromTime(input.schedule?.startTime);
  const firstInMinutes = getMinutesFromTimestamp(input.firstIn.timestamp);
  if (input.lastEvent?.eventType === "clock_out") return "clocked_out";
  if (startMinutes !== null && firstInMinutes !== null && firstInMinutes > startMinutes) return "late";
  return "present";
}

export async function buildShiftBriefing(ctx: any, date: string) {
    const dayOfWeek = getDayOfWeek(date);
    const [workers, schedules, attendance, kiosks, exceptions, attendanceCorrections] = await Promise.all([
      ctx.db
        .query("workers")
        .withIndex("by_active", (q: any) => q.eq("active", true))
        .collect(),
      ctx.db
        .query("schedules")
        .withIndex("by_active", (q: any) => q.eq("active", true))
        .collect(),
      listEffectiveAttendanceByTimestampRange(ctx, date),
      ctx.db
        .query("kiosks")
        .withIndex("by_active", (q: any) => q.eq("active", true))
        .collect(),
      buildShiftExceptions(ctx, date),
      ctx.db
        .query("attendanceCorrections")
        .withIndex("by_date", (q: any) => q.eq("date", date))
        .collect(),
    ]) as [any[], any[], any[], any[], any[], any[]];

    const todaysSchedules = schedules.filter((schedule) => parseScheduleDays(schedule.days).includes(dayOfWeek));
    const eventsByWorker = new Map<string, any[]>();
    for (const event of attendance) {
      const events = eventsByWorker.get(event.workerId) || [];
      events.push(event);
      eventsByWorker.set(event.workerId, events);
    }

    const workerRows = [];
    const departmentMap = new Map<string, any>();
    let expected = 0;
    let present = 0;
    let late = 0;
    let missing = 0;
    let clockedOut = 0;

    for (const worker of workers) {
      const schedule = getScheduleForWorker(worker, schedules, dayOfWeek);
      if (!schedule) continue;

      expected += 1;
      const workerId = String(worker._id);
      const events = [...(eventsByWorker.get(workerId) || [])].sort((a, b) =>
        a.timestamp.localeCompare(b.timestamp),
      );
      const firstIn = events.find((event) => event.eventType === "clock_in") || null;
      const lastEvent = events[events.length - 1] || null;
      const status = getWorkerStatus({ schedule, firstIn, lastEvent });
      const department = normalizeText(worker.department) || "Unassigned";
      const departmentKey = `${department}:${schedule.name}:${schedule.startTime}:${schedule.endTime}`;

      if (status === "late") late += 1;
      if (status === "missing") missing += 1;
      if (status === "clocked_out") clockedOut += 1;
      if (status === "present" || status === "late") present += 1;

      if (!departmentMap.has(departmentKey)) {
        departmentMap.set(departmentKey, {
          department,
          schedule_name: schedule.name,
          scheduled_start: schedule.startTime,
          scheduled_end: schedule.endTime,
          expected: 0,
          present: 0,
          late: 0,
          missing: 0,
          clocked_out: 0,
          status: "covered" as DepartmentCoverageStatus,
        });
      }

      const departmentRow = departmentMap.get(departmentKey);
      departmentRow.expected += 1;
      if (status === "present" || status === "late") departmentRow.present += 1;
      if (status === "late") departmentRow.late += 1;
      if (status === "missing") departmentRow.missing += 1;
      if (status === "clocked_out") departmentRow.clocked_out += 1;

      workerRows.push({
        worker_id: workerId,
        worker_name: worker.name || "Unknown worker",
        department,
        schedule_name: schedule.name,
        scheduled_start: schedule.startTime,
        scheduled_end: schedule.endTime,
        status,
        first_seen: firstIn?.timestamp || null,
        last_seen: lastEvent?.timestamp || null,
        event_count: events.length,
      });
    }

    const departmentRows = [...departmentMap.values()].map((row) => {
      let status: DepartmentCoverageStatus = "covered";
      if (row.missing > 0 || row.late > 0) status = "short";
      if (row.present === 0 && row.expected > 0) status = "critical";
      return { ...row, status };
    });
    departmentRows.sort((a, b) =>
      (b.missing + b.late) - (a.missing + a.late) ||
      a.department.localeCompare(b.department),
    );

    workerRows.sort((a, b) => {
      const order: Record<WorkerCoverageStatus, number> = {
        missing: 0,
        late: 1,
        still_clocked_in: 2,
        present: 3,
        clocked_out: 4,
      };
      return order[a.status] - order[b.status] || a.worker_name.localeCompare(b.worker_name);
    });

    const kioskRows = kiosks.map((kiosk) => ({
      id: String(kiosk._id),
      name: kiosk.name,
      kiosk_id: kiosk.kioskId || null,
      type: kiosk.type,
      location: kiosk.location,
      last_sync: kiosk.lastSync || null,
      status: getKioskStatus(kiosk.lastSync),
      device_fault: hasScanBlockingDeviceFault(kiosk.health),
    }));
    const kioskCounts = kioskRows.reduce(
      (acc, kiosk) => {
        acc[kiosk.status] += 1;
        return acc;
      },
      { online: 0, stale: 0, offline: 0, never_synced: 0 } as Record<KioskStatus, number>,
    );
    // Every reported scan-blocking fault drives blockers/severity — a stale
    // kiosk whose last report says the camera is broken still cannot scan.
    const deviceFaultKiosks = kioskRows.filter((kiosk) => kiosk.device_fault).length;
    // But only otherwise-healthy rows add to the warning total: stale/offline/
    // never-synced rows are already counted once (no double counting).
    const deviceFaultWarningKiosks = kioskRows.filter(
      (kiosk) => kiosk.device_fault && kiosk.status === "online",
    ).length;

    const openExceptions = exceptions.filter((exception) => exception.status === "open");
    const recognitionReviews = openExceptions.filter((exception) => exception.type === "recognition_review");
    const criticalExceptions = openExceptions.filter((exception) => exception.severity === "critical");
    const missingClockOuts = openExceptions.filter((exception) => exception.type === "missing_clock_out");
    const exceptionActions = openExceptions.filter((exception) => exception.type !== "recognition_review");
    const actionItems = [
      ...departmentRows
        .filter((row) => row.status !== "covered")
        .map((row) => ({
          id: `coverage:${row.department}:${row.schedule_name}`,
          priority: row.status === "critical" ? "critical" as ActionPriority : "warning" as ActionPriority,
          label: `${row.department} coverage ${row.status === "critical" ? "critical" : "short"}`,
          description: `${row.present}/${row.expected} expected workers are currently present; ${row.missing} missing and ${row.late} late.`,
          href: buildHref("/briefing", {
            date,
            department: row.department,
            status: getCoverageActionStatus(row),
          }),
        })),
      ...(recognitionReviews.length > 0
        ? [{
            id: "recognition:trust-review",
            priority: getRecognitionReviewPriority(recognitionReviews),
            label: "Recognition confidence needs review",
            description: `${recognitionReviews.length} recognition ${recognitionReviews.length === 1 ? "attempt needs" : "attempts need"} review before today's coverage can be trusted.`,
            href: getRecognitionReviewHref(date, recognitionReviews),
          }]
        : []),
      ...exceptionActions.slice(0, 8).map((exception) => ({
        id: exception.key,
        priority: exception.severity as ActionPriority,
        label: exception.title,
        description: exception.description,
        href: buildHref("/exceptions", {
          date,
          status: "open",
          department: exception.department,
          type: exception.type,
          severity: exception.severity,
          exception_key: exception.key,
          intent: getExceptionIntent(exception),
        }),
      })),
      ...kioskRows
        .filter((kiosk) => kiosk.status === "offline" || kiosk.status === "never_synced" || kiosk.status === "stale")
        .map((kiosk) => ({
          id: `kiosk:${kiosk.id}`,
          priority: kiosk.status === "stale" ? "warning" as ActionPriority : "critical" as ActionPriority,
          label: `${kiosk.name} is ${kiosk.status === "never_synced" ? "not synced" : kiosk.status}`,
          description: `${kiosk.location || "No location set"} may reduce confidence in today's coverage view.`,
          href: "/kiosks",
        })),
      ...kioskRows
        .filter((kiosk) => kiosk.device_fault)
        .map((kiosk) => ({
          id: `kiosk-device:${kiosk.id}`,
          priority: "critical" as ActionPriority,
          label: `${kiosk.name} reports a device fault`,
          description: `${kiosk.location || "No location set"} cannot scan faces until the reported camera, model, or roster fault is fixed.`,
          href: "/kiosks",
        })),
      ...(todaysSchedules.length === 0
        ? [{
            id: "schedules:none-today",
            priority: "warning" as ActionPriority,
            label: "No schedule is active today",
            description: "Coverage risk cannot be calculated until a schedule includes this day.",
            href: "/schedules",
          }]
        : []),
    ].sort((a, b) => actionRank(a.priority) - actionRank(b.priority) || a.label.localeCompare(b.label));
    const generatedAt = new Date().toISOString();
    const summary = {
      expected,
      present,
      late,
      missing,
      clocked_out: clockedOut,
      departments: departmentRows.length,
      open_exceptions: openExceptions.length,
      recognition_reviews: recognitionReviews.length,
      critical_actions: actionItems.filter((item) => item.priority === "critical").length,
      kiosk_warnings: kioskCounts.stale + kioskCounts.offline + kioskCounts.never_synced + deviceFaultWarningKiosks,
    };
    const shiftTrustBrief = buildShiftTrustBrief({
      date,
      generatedAt,
      summary,
      actionItems,
      todaysSchedules,
      workers,
      openExceptions,
      criticalExceptions,
      missingClockOuts,
      recognitionReviews,
      kioskCounts,
      deviceFaultKiosks,
      deviceFaultWarningKiosks,
      attendanceCorrections,
    });

    return {
      date,
      generated_at: generatedAt,
      summary,
      departments: departmentRows,
      workers: workerRows,
      action_items: actionItems,
      kiosks: {
        total: kioskRows.length,
        counts: kioskCounts,
        rows: kioskRows,
      },
      schedules: {
        active_today: todaysSchedules.length,
        total_active: schedules.length,
      },
      shift_trust_brief: shiftTrustBrief,
    };
}

export const summary = query({
  args: { date: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await assertPortalRole(ctx, ["admin", "enrollment", "viewer"]);
    const date = args.date || getFactoryLocalDateKey(new Date().toISOString())!;
    return buildShiftBriefing(ctx, date);
  },
});
