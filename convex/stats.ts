import { getFactoryLocalDateKey } from "./localDate";
import { query } from "./_generated/server";
import { v } from "convex/values";
import { assertPortalRole } from "./access";
import { listEffectiveAttendanceByTimestampRange } from "./attendance";

function getDateKey(timestamp: string): string {
  return timestamp.slice(0, 10);
}
function getMinutesFromTimestamp(timestamp: string): number | null {
  const match = timestamp.match(/T(\d{2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function getDayOfWeek(dateKey: string): number {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, day).getDay();
}

export const get = query({
  args: { date: v.optional(v.string()) },
  returns: v.object({
    totalWorkers: v.number(),
    clockedIn: v.number(),
    clockedOut: v.number(),
    notArrived: v.number(),
    avgArrival: v.union(v.string(), v.null()),
    scheduleWarning: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    await assertPortalRole(ctx, ["admin", "enrollment", "viewer"]);

    const today = args.date || getFactoryLocalDateKey(new Date().toISOString())!;

    const activeWorkers = await ctx.db
      .query("workers")
      .withIndex("by_active", (q) => q.eq("active", true))
      .collect();
    const totalWorkers = activeWorkers.length;
    const activeWorkerIds = new Set<string>(activeWorkers.map((worker) => String(worker._id)));

    // All dashboard metrics use the current active roster, including historical dates.
    // Filter only this summary; attendance history still retains inactive workers.
    const todayAttendance = (await listEffectiveAttendanceByTimestampRange(ctx, today))
      .filter((record) => activeWorkerIds.has(record.workerId));

    // The helper orders by instant, including offsets and subsecond precision.
    // Latest event per worker
    const workerStatus = new Map<string, { eventType: string; timestamp: string }>();
    for (const a of todayAttendance) {
      workerStatus.set(a.workerId, { eventType: a.eventType, timestamp: a.timestamp });
    }

    let clockedIn = 0;
    let clockedOut = 0;
    for (const s of workerStatus.values()) {
      if (s.eventType === "clock_in") clockedIn++;
      else clockedOut++;
    }
    const notArrived = totalWorkers - workerStatus.size;

    // Average arrival
    const firstIns = new Map<string, string>();
    for (const a of todayAttendance) {
      if (a.eventType === "clock_in") {
        if (!firstIns.has(a.workerId)) {
          firstIns.set(a.workerId, a.timestamp);
        }
      }
    }

    let avgArrival: string | null = null;
    if (firstIns.size > 0) {
      const arrivalMinutes = [...firstIns.values()]
        .map((ts) => getMinutesFromTimestamp(ts))
        .filter((value): value is number => value !== null);
      if (arrivalMinutes.length > 0) {
        const totalMinutes = arrivalMinutes.reduce((sum, value) => sum + value, 0);
        const avgMin = Math.round(totalMinutes / arrivalMinutes.length);
        const h = Math.floor(avgMin / 60);
        const m = avgMin % 60;
        avgArrival = `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
      }
    }

    // Schedule check
    const dayOfWeek = getDayOfWeek(today);
    const schedules = await ctx.db
      .query("schedules")
      .withIndex("by_active", (q) => q.eq("active", true))
      .collect();
    const hasScheduleToday = schedules.some((s) => {
      try {
        return (JSON.parse(s.days) as number[]).includes(dayOfWeek);
      } catch {
        return false;
      }
    });

    return {
      totalWorkers,
      clockedIn,
      clockedOut,
      notArrived,
      avgArrival,
      ...(hasScheduleToday ? {} : { scheduleWarning: "No schedule found for today" }),
    };
  },
});
