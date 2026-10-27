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
 * carries its correction's date, so one `by_date` read per date replaces a
 * lookup (and an index range) per correction; each date is read once per scope
 * however callers' date ranges overlap. Callers reject a correction with more
 * than one reversal as ambiguous. */
export async function listCorrectionReversals(ctx: any, corrections: readonly { _id: string; date: string }[]) {
  const byCorrection = new Map(corrections.map(correction => [String(correction._id), [] as any[]]));
  const dates = [...new Set(corrections.map(correction => correction.date))];
  const reads = await Promise.all(dates.map(date => shared(sharedReads.get(ctx.db)?.reversals, date, () => ctx.db
    .query("attendanceCorrectionReversals")
    .withIndex("by_date", (q: any) => q.eq("date", date))
    .collect())));
  for (const reversal of reads.flat()) byCorrection.get(String(reversal.correctionId))?.push(reversal);
  return byCorrection;
}

/** As `listCorrectionReversals`, for a few corrections (one worker's day): a
 * lookup per correction reads only their reversals, not the whole date's. */
export async function listReversalsPerCorrection(ctx: any, corrections: readonly { _id: string }[]) {
  return new Map(await Promise.all(corrections.map(async correction => [String(correction._id), await ctx.db
    .query("attendanceCorrectionReversals")
    .withIndex("by_correctionId", (q: any) => q.eq("correctionId", correction._id))
    .take(2)] as [string, any[]])));
}
