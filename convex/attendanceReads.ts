// One closeout transaction builds the briefing, exceptions and the signed
// attendance baseline, which repeat the same attendance scans, correction reads
// and reversal reads. Convex bounds documents scanned and index ranges per transaction, so
// a read-only scope shares those results instead of re-reading them.
type SharedReads = {
  scans: Map<string, Promise<any[]>>;
  corrections: Map<string, Promise<any[]>>;
  reversals: Map<string, Promise<any[]>>;
};

const sharedReads = new WeakMap<object, SharedReads>();

/** Share attendance reads on this transaction until the returned function is
 * called. End the scope before any write: cached reads would not see it. */
export function shareAttendanceReads(ctx: { db: object }) {
  if (sharedReads.has(ctx.db)) return () => {};
  sharedReads.set(ctx.db, { scans: new Map(), corrections: new Map(), reversals: new Map() });
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

/** All corrections recorded for the inclusive factory dates, including reversed ones. */
export async function listCorrectionsByDateRange(ctx: any, startDate: string, endDate = startDate) {
  return shared(sharedReads.get(ctx.db)?.corrections, `${startDate}\u0000${endDate}`, () => ctx.db
    .query("attendanceCorrections")
    .withIndex("by_date", (q: any) => startDate === endDate ? q.eq("date", startDate) : q.gte("date", startDate).lte("date", endDate))
    .collect());
}

/** Reversals of the given corrections, grouped by correction id. A reversal
 * carries its correction's date, so one `by_date` range read over the
 * corrections' dates replaces a lookup (and an index range) per correction.
 * Callers reject a correction with more than one reversal as ambiguous. */
export async function listCorrectionReversals(ctx: any, corrections: readonly { _id: string; date: string }[]) {
  const byCorrection = new Map<string, any[]>();
  if (corrections.length === 0) return byCorrection;
  for (const correction of corrections) byCorrection.set(String(correction._id), []);
  const dates = corrections.map(correction => correction.date).sort();
  const [startDate, endDate] = [dates[0], dates[dates.length - 1]];
  const reversals = await shared(sharedReads.get(ctx.db)?.reversals, `${startDate}\u0000${endDate}`, () => ctx.db
    .query("attendanceCorrectionReversals")
    .withIndex("by_date", (q: any) => startDate === endDate ? q.eq("date", startDate) : q.gte("date", startDate).lte("date", endDate))
    .collect());
  for (const reversal of reversals) byCorrection.get(String(reversal.correctionId))?.push(reversal);
  return byCorrection;
}
