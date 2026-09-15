import { ConvexError } from "convex/values";
import { isValidFactoryLocalDateKey } from "./localDate";

export const MAX_ATTENDANCE_BATCH_SIZE = 500;
export type AttendanceEvent = {
  workerId: string;
  eventType: "clock_in" | "clock_out";
  timestamp: string;
  kioskId?: string;
  idempotencyKey?: string;
  workerName?: string;
  confidence?: number;
  livenessConfirmed?: boolean;
};

function invalid(message: string): never {
  throw new ConvexError({ code: "INVALID_ATTENDANCE", message });
}

function text(value: unknown, field: string, required = false, max = 256): string | undefined {
  if (value === undefined || value === null) {
    if (required) invalid(`${field} is required`);
    return undefined;
  }
  if (typeof value !== "string") invalid(`${field} must be a string`);
  const result = value.trim();
  if (required && !result) invalid(`${field} is required`);
  if (result.length > max) invalid(`${field} is too long`);
  return result || undefined;
}

export function isValidAttendanceTimestamp(timestamp: string): boolean {
  // Pi clocks use factory-local timestamps; explicit UTC/offset inputs remain
  // supported. Validate the whole value so date-only/overflow strings cannot
  // enter attendance and disappear from daily reports.
  const match = /^(\d{4}-\d{2}-\d{2})[T ]([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})?$/.exec(timestamp);
  return Boolean(match && isValidFactoryLocalDateKey(match[1]) && (!match[5] || Number.isFinite(Date.parse(timestamp))));
}

export function validateAttendanceEvent(value: unknown): AttendanceEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Each attendance event must be an object");
  const event = value as Record<string, unknown>;
  const workerId = text(event.workerId, "workerId", true)!;
  const eventType = text(event.eventType, "eventType", true);
  if (eventType !== "clock_in" && eventType !== "clock_out") invalid("eventType must be clock_in or clock_out");
  const timestamp = text(event.timestamp, "timestamp", true, 64)!;
  if (!isValidAttendanceTimestamp(timestamp)) {
    invalid("timestamp must be a valid ISO date and time, with optional UTC offset");
  }
  if (event.confidence !== undefined && (typeof event.confidence !== "number" || !Number.isFinite(event.confidence) || event.confidence < -1e-12 || event.confidence > 1 + 1e-12)) {
    invalid("confidence must be a finite number from 0 to 1");
  }
  if (event.livenessConfirmed !== undefined && typeof event.livenessConfirmed !== "boolean") invalid("livenessConfirmed must be a boolean");
  return {
    workerId,
    eventType,
    timestamp,
    kioskId: text(event.kioskId, "kioskId", false, 128),
    idempotencyKey: text(event.idempotencyKey ?? event.id, "idempotencyKey"),
    workerName: text(event.workerName, "workerName", false, 200),
    // Floating-point cosine division can exceed 1 by a few ulps.
    confidence: event.confidence === undefined ? undefined : Math.max(0, Math.min(1, event.confidence as number)),
    livenessConfirmed: event.livenessConfirmed as boolean | undefined,
  };
}

export function validateAttendanceBatch(events: unknown): AttendanceEvent[] {
  if (!Array.isArray(events) || events.length > MAX_ATTENDANCE_BATCH_SIZE) invalid(`events must be an array of at most ${MAX_ATTENDANCE_BATCH_SIZE} events`);
  return events.map(validateAttendanceEvent);
}
