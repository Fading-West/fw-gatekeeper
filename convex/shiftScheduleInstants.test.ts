/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function fixture(date: string, startTime: string, timestamp: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${date}T09:00:00Z`));
  const t = convexTest(schema, modules);
  const { userId, workerId } = await t.run(async (ctx) => {
    const createdAt = "2026-01-01T00:00:00Z";
    const userId = await ctx.db.insert("users", { email: "supervisor@example.com" });
    await ctx.db.insert("portalMembers", { userId, role: "admin", active: true, createdAt });
    const workerId = await ctx.db.insert("workers", {
      name: "Avery", department: "Assembly", active: true, enrolledAt: createdAt,
    });
    await ctx.db.insert("schedules", {
      name: "Morning", days: "[0,1,2,3,4,5,6]", startTime, endTime: "17:00",
      department: "Assembly", active: true, createdAt,
    });
    await ctx.db.insert("attendance", { workerId: String(workerId), eventType: "clock_in", timestamp, synced: true });
    return { userId, workerId: String(workerId) };
  });
  return { admin: t.withIdentity({ subject: userId }), workerId };
}

describe("schedule lateness compares punch instants", () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    { label: "second fall-back hour", date: "2026-11-01", start: "01:30", punch: "2026-11-01T01:15:00-06:00", severity: "critical" },
    { label: "second fall-back hour in UTC", date: "2026-11-01", start: "01:30", punch: "2026-11-01T07:15:00Z", severity: "critical" },
    { label: "first fall-back hour", date: "2026-11-01", start: "01:30", punch: "2026-11-01T01:15:00-05:00", severity: null },
    { label: "legacy first-occurrence fall-back punch", date: "2026-11-01", start: "01:30", punch: "2026-11-01T01:15:00", severity: null },
    { label: "fall-back warning boundary", date: "2026-11-01", start: "01:30", punch: "2026-11-01T01:59:59-05:00", severity: "warning" },
    { label: "fall-back critical boundary", date: "2026-11-01", start: "01:30", punch: "2026-11-01T01:00:00-06:00", severity: "critical" },
    // Only 15 elapsed minutes: the skipped hour must not raise severity to critical.
    { label: "spring-forward elapsed severity", date: "2026-03-08", start: "01:50", punch: "2026-03-08T03:05:00-05:00", severity: "warning" },
    { label: "skipped spring-forward start keeps wall-time policy", date: "2026-03-08", start: "02:30", punch: "2026-03-08T03:00:00-05:00", severity: "critical" },
    { label: "ordinary early arrival", date: "2026-09-03", start: "08:00", punch: "2026-09-03T07:55:00-05:00", severity: null },
    { label: "ordinary start minute ignores seconds", date: "2026-09-03", start: "08:00", punch: "2026-09-03T08:00:59.999999-05:00", severity: null },
    { label: "ordinary first late minute", date: "2026-09-03", start: "08:00", punch: "2026-09-03T08:01:00", severity: "warning" },
    { label: "ordinary warning boundary", date: "2026-09-03", start: "08:00", punch: "2026-09-03T08:29:59.999999-05:00", severity: "warning" },
    { label: "ordinary critical boundary", date: "2026-09-03", start: "08:00", punch: "2026-09-03T08:30:00-05:00", severity: "critical" },
  ])("uses elapsed minutes for $label", async ({ date, start, punch, severity }) => {
    const { admin } = await fixture(date, start, punch);
    const briefing = await admin.query(api.shiftBriefing.summary, { date });
    const exceptions = await admin.query(api.shiftExceptions.summary, { date });
    const closeout = await admin.query(api.shiftCloseouts.get, { date });
    const late = severity ? 1 : 0;

    expect(briefing.workers[0].status).toBe(severity ? "late" : "present");
    expect(briefing.summary).toMatchObject({ present: 1, late });
    expect(briefing.daily_attendance).toMatchObject({ present: 1, late });
    expect(closeout.summary).toMatchObject({ present: 1, late });
    const lateArrivals = exceptions.exceptions.filter(row => row.type === "late_arrival");
    expect(lateArrivals).toHaveLength(late);
    if (severity) expect(lateArrivals[0]).toMatchObject({ severity, scheduled_start: start });
  });

  it("records the fall-back repro as late after clock-out and in the signed closeout", async () => {
    const date = "2026-11-01";
    const { admin, workerId } = await fixture(date, "01:30", `${date}T01:15:00-06:00`);
    await admin.run(async (ctx) => {
      const schedule = (await ctx.db.query("schedules").collect())[0];
      await ctx.db.patch(schedule._id, { days: "[0]", endTime: "03:00" });
      await ctx.db.insert("attendance", { workerId, eventType: "clock_out", timestamp: `${date}T03:00:00-06:00`, synced: true });
    });
    vi.setSystemTime(new Date(`${date}T09:01:00Z`));

    const briefing = await admin.query(api.shiftBriefing.summary, { date });
    expect(briefing.workers[0].status).toBe("clocked_out");
    expect(briefing.daily_attendance).toMatchObject({ present: 1, late: 1 });
    await admin.mutation(api.shiftCloseouts.save, {
      date, action: "complete", acknowledgedBlockers: true, notes: "Reviewed the late arrival during the repeated hour.",
    });
    const closeout = await admin.query(api.shiftCloseouts.get, { date });
    expect(closeout.summary).toMatchObject({ present: 1, late: 1 });
    expect(closeout.closeout?.snapshot).toMatchObject({ present: 1, late: 1 });
  });
});
