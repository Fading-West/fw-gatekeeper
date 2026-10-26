// One closeout transaction builds the briefing, exceptions and the signed
// attendance baseline, which repeat the same attendance scans and reversal
// lookups. Convex bounds documents scanned and index ranges per transaction, so
// a read-only scope shares those results instead of re-reading them.
type SharedReads = {
  scans: Map<string, Promise<any[]>>;
  reversals: Map<string, Promise<any[]>>;
};

const sharedReads = new WeakMap<object, SharedReads>();

/** Share attendance reads on this transaction until the returned function is
 * called. End the scope before any write: cached reads would not see it. */
export function shareAttendanceReads(ctx: { db: object }) {
  if (sharedReads.has(ctx.db)) return () => {};
  sharedReads.set(ctx.db, { scans: new Map(), reversals: new Map() });
  return () => { sharedReads.delete(ctx.db); };
}

async function shared(cache: Map<string, Promise<any[]>> | undefined, key: string, read: () => Promise<any[]>) {
  if (!cache) return read();
  let pending = cache.get(key);
  if (!pending) {
    pending = read();
    cache.set(key, pending);
  }
  // Callers own their array; documents themselves are never mutated.
  return [...await pending];
}

export async function scanAttendanceByTimestamp(ctx: any, range: { startTimestamp: string; endTimestamp: string }, workerId?: string) {
  return shared(sharedReads.get(ctx.db)?.scans, `${range.startTimestamp}\u0000${range.endTimestamp}\u0000${workerId ?? ""}`, () => {
    const query = ctx.db
      .query("attendance")
      .withIndex("by_timestamp", (q: any) => q.gte("timestamp", range.startTimestamp).lt("timestamp", range.endTimestamp));
    return (workerId ? query.filter((q: any) => q.eq(q.field("workerId"), workerId)) : query).collect();
  });
}

/** Up to two reversals, so callers can reject an ambiguous duplicate. */
export async function listCorrectionReversals(ctx: any, correctionId: string) {
  return shared(sharedReads.get(ctx.db)?.reversals, String(correctionId), () => ctx.db
    .query("attendanceCorrectionReversals")
    .withIndex("by_correctionId", (q: any) => q.eq("correctionId", correctionId))
    .take(2));
}
