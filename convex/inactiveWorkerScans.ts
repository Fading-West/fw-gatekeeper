import type { Doc } from "./_generated/dataModel";
import { getFactoryLocalTimestamp } from "./localDate";
import { createRecognitionTimestampSortKey } from "./recognitionTimestamp";

const ENROLL_ACTION = "workers.enroll";
const DEACTIVATION_ACTIONS = new Set(["workers.remove", "workers.purgeBiometrics"]);

export type InactiveWorkerScanExceptionInput = {
  key: string;
  date: string;
  type: "inactive_worker_scan";
  severity: "critical";
  title: string;
  description: string;
  worker_id: string;
  worker_name: string;
  department: string | null;
  kiosk_id: string | null;
  kiosk_name: string | null;
  first_seen: string;
  last_seen: string;
  schedule_name: null;
  scheduled_start: null;
  scheduled_end: null;
  event_count: number;
  attendance_id: string;
  links: { activity_log: string; worker: string };
};

type DeactivationBoundary = {
  // UTC ISO time. Never earlier than the real deactivation, so a flagged scan
  // is always after it; an approximate boundary can only miss earlier scans.
  at: string;
  exact: boolean;
};

function parseDetails(details?: string) {
  try {
    const parsed = details ? JSON.parse(details) : null;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function findDeactivationBoundary(ctx: any, worker: Doc<"workers">): Promise<DeactivationBoundary | null> {
  const rows = await ctx.db
    .query("auditLog")
    .withIndex("by_target", (q: any) => q.eq("targetTable", "workers").eq("targetId", String(worker._id)))
    .collect();
  rows.sort((a: any, b: any) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a._creationTime - b._creationTime);

  // An enroll row (new enrollment, restore, or re-enrollment) means the worker
  // was active then. Repeated Removes each write a row, so take the earliest
  // deactivation after the latest enroll, not the latest deactivation.
  let lastEnrollIndex = -1;
  rows.forEach((row: any, index: number) => {
    if (row.action === ENROLL_ACTION) lastEnrollIndex = index;
  });
  const deactivation = rows.slice(lastEnrollIndex + 1).find((row: any) => DEACTIVATION_ACTIONS.has(row.action));
  if (deactivation) {
    const wasActive = deactivation.action === "workers.purgeBiometrics" &&
      parseDetails(deactivation.details)?.wasActive === true;
    return { at: deactivation.createdAt, exact: lastEnrollIndex >= 0 || wasActive };
  }

  // Deactivated before audit rows existed: updatedAt is written on deactivation
  // and inactive workers cannot be edited, so it is a safe upper bound.
  return worker.updatedAt ? { at: worker.updatedAt, exact: false } : null;
}

function formatFactoryDateTime(timestamp: string) {
  const local = getFactoryLocalTimestamp(timestamp);
  return local && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(local)
    ? `${local.slice(0, 10)} ${local.slice(11, 16)}`
    : timestamp;
}

function rosterSentence(
  kiosk: Doc<"kiosks"> | null,
  boundary: DeactivationBoundary,
  boundaryKey: string,
  sortKey: (timestamp: string) => string,
) {
  // Current context only: the kiosk may have held a different roster when it
  // recorded the scan.
  if (!kiosk) return "Roster receipt information is unavailable for this kiosk.";
  if (!kiosk.rosterAppliedAt) return "This kiosk has not acknowledged any roster receipt.";
  const receiptKey = sortKey(kiosk.rosterAppliedAt);
  if (boundary.exact && receiptKey && receiptKey < boundaryKey) {
    return "This kiosk's latest acknowledged roster receipt was issued before the deactivation.";
  }
  return `This kiosk's latest acknowledged roster receipt was issued at ${formatFactoryDateTime(kiosk.rosterAppliedAt)}.`;
}

/**
 * Kiosk attendance from a worker who is currently inactive, at or after their
 * deactivation, means a door kept accepting someone whose access was removed.
 * Ingest keeps that evidence on purpose, so surface each scan for review.
 */
export async function buildInactiveWorkerScanExceptions(
  ctx: any,
  input: {
    date: string;
    attendance: any[];
    activeWorkerIds: Set<string>;
    resolveKiosk: (identifier?: string | null) => Promise<Doc<"kiosks"> | null>;
    activityLogHref: (date: string, workerId: string, attendanceId: string) => string;
  },
): Promise<InactiveWorkerScanExceptionInput[]> {
  const candidates = input.attendance.filter((event) =>
    event.source === "kiosk" &&
    !String(event._id).startsWith("correction:") &&
    !input.activeWorkerIds.has(String(event.workerId)));
  if (candidates.length === 0) return [];

  const sortKey = createRecognitionTimestampSortKey();
  const workerIds = [...new Set(candidates.map((event) => String(event.workerId)))];
  const workers = new Map<string, { worker: Doc<"workers">; boundary: DeactivationBoundary; boundaryKey: string }>();
  await Promise.all(workerIds.map(async (workerId) => {
    const id = ctx.db.normalizeId("workers", workerId);
    const worker: Doc<"workers"> | null = id ? await ctx.db.get(id) : null;
    if (!worker || worker.active === true) return;
    const boundary = await findDeactivationBoundary(ctx, worker);
    // Without any deactivation evidence, never guess an earlier boundary.
    if (!boundary) return;
    workers.set(workerId, { worker, boundary, boundaryKey: sortKey(boundary.at) });
  }));

  const exceptions: InactiveWorkerScanExceptionInput[] = [];
  for (const event of candidates) {
    const workerId = String(event.workerId);
    const entry = workers.get(workerId);
    if (!entry) continue;
    const { worker, boundary, boundaryKey } = entry;
    // Compare UTC instants, never factory wall time. chronologicalKey resolves
    // an offset-free legacy scan in a repeated DST hour to the earlier
    // occurrence (see createRecognitionTimestampSortKey). An unparseable
    // scan or boundary time ("") is never flagged.
    const eventKey = String(event.chronologicalKey || "");
    if (!eventKey || !boundaryKey || eventKey < boundaryKey) continue;

    const attendanceId = String(event._id);
    const name = worker.name || event.workerName || "Unknown worker";
    const kiosk = await input.resolveKiosk(event.kioskId);
    const kioskLabel = kiosk?.name || event.kioskId || "unknown kiosk";
    const eventLabel = event.eventType === "clock_in"
      ? "clock in"
      : event.eventType === "clock_out" ? "clock out" : String(event.eventType || "scan").replace(/_/g, " ");
    const deactivated = boundary.exact
      ? `was deactivated at ${formatFactoryDateTime(boundary.at)}`
      : `was deactivated on or before ${formatFactoryDateTime(boundary.at)}`;
    const activityLog = input.activityLogHref(input.date, workerId, attendanceId);

    exceptions.push({
      key: `${input.date}:inactive_worker_scan:${workerId}:${attendanceId}`,
      date: input.date,
      type: "inactive_worker_scan",
      severity: "critical",
      title: `${name} scanned after being deactivated`,
      description: `${name} ${deactivated}, but kiosk ${kioskLabel} recorded a ${eventLabel} at ${String(event.timestamp).slice(11, 16)}. ${rosterSentence(kiosk, boundary, boundaryKey, sortKey)}`,
      worker_id: workerId,
      worker_name: name,
      department: worker.department || null,
      kiosk_id: event.kioskId || null,
      kiosk_name: kiosk?.name || null,
      first_seen: event.timestamp,
      last_seen: event.timestamp,
      schedule_name: null,
      scheduled_start: null,
      scheduled_end: null,
      event_count: 1,
      attendance_id: attendanceId,
      links: { activity_log: activityLog, worker: "/workers" },
    });
  }
  return exceptions;
}
