import { sha256 } from '@oslojs/crypto/sha2';
import { v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { buildConservativeFactoryLocalTimestampRanges, timestampBelongsToFactoryLocalDate } from './localDate';

// Widen version for forward compatibility: old readers report unknown for new versions.
export const signedAttendanceEvidenceValidator = v.object({
  version: v.number(), digest: v.string(), raw_punches: v.number(),
  corrections: v.number(), reversals: v.number(),
});
export type SignedAttendanceEvidence = {
  version: number; digest: string; raw_punches: number; corrections: number; reversals: number;
};
export const ATTENDANCE_EVIDENCE_SCOPE = 'Attendance evidence for this factory date only';
export const MAX_ATTENDANCE_EVIDENCE_ROWS = 4000;
const MAX_CANONICAL_BYTES = 2_000_000;
type EvidenceInput = {
  raw: readonly Doc<'attendance'>[];
  corrections: readonly Doc<'attendanceCorrections'>[];
  reversals: readonly Doc<'attendanceCorrectionReversals'>[];
};
const byId = <T extends { id: string }>(rows: T[]) => rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Whitelisted persisted evidence, not effective totals. No display normalization:
 * offsets, fractional seconds, voids and later reversals are part of the signature.
 * Missing optional values consistently encode as null. */
export function buildSignedAttendanceEvidence(date: string, input: EvidenceInput): SignedAttendanceEvidence {
  const { raw, corrections, reversals } = input;
  if (raw.length + corrections.length + reversals.length > MAX_ATTENDANCE_EVIDENCE_ROWS) {
    throw new Error('Attendance evidence exceeds the safe comparison limit.');
  }
  const canonical = JSON.stringify({ version: 1, date,
    raw: byId(raw.map(row => ({
      id: String(row._id), workerId: row.workerId, eventType: row.eventType,
      timestamp: row.timestamp, kioskId: row.kioskId ?? null,
      confidence: row.confidence ?? null, livenessConfirmed: row.livenessConfirmed ?? null, note: row.note ?? null,
    }))),
    corrections: byId(corrections.map(row => ({
      id: String(row._id), date: row.date, workerId: row.workerId, action: row.action,
      eventType: row.eventType ?? null, correctedTimestamp: row.correctedTimestamp ?? null,
      originalAttendanceId: row.originalAttendanceId ?? null, reason: row.reason,
      supervisorName: row.supervisorName ?? null, actorUserId: row.actorUserId ?? null, createdAt: row.createdAt,
    }))),
    reversals: byId(reversals.map(row => ({
      id: String(row._id), correctionId: row.correctionId, date: row.date, workerId: row.workerId,
      reason: row.reason, actorUserId: row.actorUserId, createdAt: row.createdAt,
    }))),
  });
  const bytes = new TextEncoder().encode(canonical);
  if (bytes.length > MAX_CANONICAL_BYTES) throw new Error('Attendance evidence exceeds the safe comparison size.');
  const digest = Array.from(sha256(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
  return { version: 1, digest, raw_punches: raw.length, corrections: corrections.length, reversals: reversals.length };
}

/** Read only bounded persisted documents. Never use the display-normalized reader
 * or active-only corrections: both discard evidence needed by this signature. */
export async function readSignedAttendanceEvidence(ctx: Pick<QueryCtx, 'db'>, date: string): Promise<SignedAttendanceEvidence> {
  const rawById = new Map<string, Doc<'attendance'>>();
  for (const range of buildConservativeFactoryLocalTimestampRanges(date)) {
    const rows = await ctx.db.query('attendance').withIndex('by_timestamp', q =>
      q.gte('timestamp', range.startTimestamp).lt('timestamp', range.endTimestamp))
      .take(MAX_ATTENDANCE_EVIDENCE_ROWS + 1);
    // A truncated conservative range cannot establish complete evidence.
    if (rows.length > MAX_ATTENDANCE_EVIDENCE_ROWS) throw new Error('Attendance evidence range exceeds the safe comparison limit.');
    for (const row of rows) if (timestampBelongsToFactoryLocalDate(row.timestamp, date)) rawById.set(String(row._id), row);
  }
  const corrections = await ctx.db.query('attendanceCorrections')
    .withIndex('by_date', q => q.eq('date', date)).take(MAX_ATTENDANCE_EVIDENCE_ROWS + 1);
  if (rawById.size + corrections.length > MAX_ATTENDANCE_EVIDENCE_ROWS) throw new Error('Attendance evidence exceeds the safe comparison limit.');
  const reversals: Doc<'attendanceCorrectionReversals'>[] = [];
  for (const correction of corrections) {
    const rows = await ctx.db.query('attendanceCorrectionReversals')
      .withIndex('by_correctionId', q => q.eq('correctionId', correction._id)).take(2);
    if (rows.length > 1) throw new Error('Attendance reversal evidence is ambiguous.');
    reversals.push(...rows);
  }
  return buildSignedAttendanceEvidence(date, { raw: [...rawById.values()], corrections, reversals });
}

export function isSignedAttendanceEvidence(value: unknown): value is SignedAttendanceEvidence {
  if (!value || typeof value !== 'object') return false;
  const evidence = value as SignedAttendanceEvidence;
  return evidence.version === 1 && /^[a-f0-9]{64}$/.test(evidence.digest) &&
    [evidence.raw_punches, evidence.corrections, evidence.reversals].every(count => Number.isSafeInteger(count) && count >= 0) &&
    evidence.raw_punches + evidence.corrections + evidence.reversals <= MAX_ATTENDANCE_EVIDENCE_ROWS;
}

export async function compareSignedAttendanceEvidence(
  ctx: Pick<QueryCtx, 'db'>, date: string, closeout: Doc<'shiftCloseouts'> | null,
) {
  const common = { scope: ATTENDANCE_EVIDENCE_SCOPE, activity_log_href: `/log?date=${date}` };
  if (closeout?.status !== 'completed') return { ...common, status: 'not_applicable' as const, reason: null, compared_at: null, signed: null, current: null };
  const signed = closeout.signedAttendanceEvidence;
  if (!isSignedAttendanceEvidence(signed)) return { ...common, status: 'unknown' as const,
    reason: signed ? 'Signed attendance evidence uses an unsupported or invalid baseline.' : 'Attendance evidence was not recorded with this signature.',
    compared_at: null, signed: null, current: null };
  try {
    const current = await readSignedAttendanceEvidence(ctx, date);
    // Counts are diagnostic. The digest determines equality, including equal-count changes.
    return { ...common, status: signed.digest === current.digest ? 'unchanged' as const : 'changed' as const,
      reason: null, compared_at: new Date().toISOString(), signed, current };
  } catch {
    // Do not turn an unavailable/truncated read into an empty, unchanged day.
    return { ...common, status: 'unknown' as const, reason: 'Current attendance evidence comparison is unavailable.',
      compared_at: null, signed, current: null };
  }
}
