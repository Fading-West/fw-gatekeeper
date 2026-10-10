/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import { createShiftClock, MAX_PLAUSIBLE_SHIFT_HOURS } from "./attendanceShifts";
import { getFactoryLocalDateKey, getNextFactoryLocalDateKey } from "./localDate";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const date = "2026-09-03";
const nextDate = getNextFactoryLocalDateKey(date);

async function setup(start: string | null, end: string | null) {
  const t = convexTest(schema, modules);
  const ids = await t.run(async ctx => {
    const userId = await ctx.db.insert("users", { email: "overnight-supervisor@example.com" });
    await ctx.db.insert("portalMembers", { userId, role: "admin", active: true, createdAt: new Date().toISOString() });
    const workerId = await ctx.db.insert("workers", { name: "Night Worker", department: "Operations", active: true, enrolledAt: date });
    // Overnight schedules remain unsupported independently of punch pairing.
    // A supported late schedule isolates the real punch/closeout bug.
    await ctx.db.insert("schedules", {
      name: "Late shift", days: "[0,1,2,3,4,5,6]", startTime: "22:00", endTime: "23:00", active: true, createdAt: date,
    });
    const startId = start ? await ctx.db.insert("attendance", { workerId, eventType: "clock_in", timestamp: start, synced: true }) : null;
    const endId = end ? await ctx.db.insert("attendance", { workerId, eventType: "clock_out", timestamp: end, synced: true }) : null;
    return { userId, workerId, startId, endId };
  });
  return { actor: t.withIdentity({ subject: ids.userId }), ...ids };
}

describe("overnight shift attribution in exceptions and closeout", () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    [`${date}T22:00:00`, `${nextDate}T06:00:00`, `${nextDate}T12:00:00Z`],
    // Absolute timestamps cross the UTC date before the factory date.
    ["2026-09-04T03:00:00Z", "2026-09-04T11:00:00Z", "2026-09-04T12:00:00Z"],
    // Fall-back and spring-forward nights: 9 and 7 elapsed hours.
    ["2026-10-31T22:00:00", "2026-11-01T06:00:00", "2026-11-01T13:00:00Z"],
    ["2026-03-07T22:00:00", "2026-03-08T06:00:00", "2026-03-08T12:00:00Z"],
    // Repeated wall-clock hour: preserve absolute chronology.
    ["2026-10-31T22:00:00-05:00", "2026-11-01T01:30:00-06:00", "2026-11-01T13:00:00Z"],
  ])("accepts a completed shift %s to %s on both factory days", async (start, end, now) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(now));
    const { actor } = await setup(start, end);
    const clockInDate = getFactoryLocalDateKey(start)!;
    const clockOutDate = getFactoryLocalDateKey(end)!;
    for (const selectedDate of [clockInDate, clockOutDate]) {
      expect((await actor.query(api.shiftExceptions.summary, { date: selectedDate })).exceptions).toEqual([]);
    }
    const closeout = await actor.query(api.shiftCloseouts.get, { date: clockInDate });
    expect(closeout.summary.missing_clock_outs).toBe(0);
    expect(closeout.blockers).toEqual([]);
    expect(closeout.can_complete).toBe(true);
    expect(closeout.closeout_draft.source_counts.missing_clock_outs).toBe(0);
    await expect(actor.mutation(api.shiftCloseouts.save, { date: clockInDate, action: "complete" })).resolves.toMatchObject({ status: "completed" });
  });

  it("keeps an in-progress shift as a warning and acknowledgement blocker without inventing an exit", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-04T04:30:00Z")); // D-1 23:30 Central
    const { actor } = await setup(`${date}T22:00:00`, null);
    const payload = await actor.query(api.shiftExceptions.summary, { date });
    expect(payload.exceptions).toMatchObject([{
      type: "missing_clock_out", severity: "warning", description: expect.stringContaining("may still be in progress"),
      suggested_resolution: { action: "review_only", can_apply: false, corrected_time: null },
    }]);
    expect(await actor.query(api.shiftCloseouts.get, { date })).toMatchObject({
      summary: { missing_clock_outs: 1 }, can_complete: false,
      blockers: [{ id: "missing_clock_outs", count: 1 }],
    });
    await expect(actor.mutation(api.shiftCloseouts.save, { date, action: "complete" })).rejects.toThrow("acknowledgement note");
    await expect(actor.mutation(api.shiftCloseouts.save, {
      date, action: "complete", acknowledgedBlockers: true, notes: "Night worker confirmed still working; exit pending.",
    })).resolves.toMatchObject({ status: "completed" });
  });

  it.each([null, "2026-09-02T22:00:00"])("still flags an orphan without a plausible adjacent entry (%s)", async start => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-04T12:00:00Z"));
    const { actor, endId } = await setup(start, `${nextDate}T06:00:00`);
    expect((await actor.query(api.shiftExceptions.summary, { date: nextDate })).exceptions).toMatchObject([{
      type: "scan_sequence", severity: "critical", attendance_id: endId,
      suggested_resolution: { action: "void_event", original_attendance_id: endId },
    }]);
  });

  it.each([
    [date, `${nextDate}T14:00:00`, `${nextDate}T14:00:01`, `${nextDate}T20:00:00Z`],
    ["2026-03-07", "2026-03-08T15:00:00", "2026-03-08T15:00:01", "2026-03-08T21:00:00Z"],
    ["2026-10-31", "2026-11-01T13:00:00", "2026-11-01T13:00:01", "2026-11-01T20:00:00Z"],
  ])("enforces the elapsed 16-hour maximum on %s, including DST", async (startDate, exact, over, now) => {
    expect(MAX_PLAUSIBLE_SHIFT_HOURS).toBe(16);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(now));
    const { actor, endId } = await setup(`${startDate}T22:00:00`, exact);
    expect((await actor.query(api.shiftExceptions.summary, { date: getNextFactoryLocalDateKey(startDate) })).exceptions).toEqual([]);
    expect((await actor.query(api.shiftCloseouts.get, { date: startDate })).summary.missing_clock_outs).toBe(0);
    await actor.run(ctx => ctx.db.patch(endId!, { timestamp: over }));
    expect((await actor.query(api.shiftExceptions.summary, { date: getNextFactoryLocalDateKey(startDate) })).exceptions).toMatchObject([{
      type: "scan_sequence", severity: "critical", description: expect.stringContaining("16-hour maximum"),
      suggested_resolution: { action: "review_only", can_apply: false },
    }]);
    expect((await actor.query(api.shiftCloseouts.get, { date: startDate })).summary.missing_clock_outs).toBe(1);
  });

  it("does not pair across workers or across a new day's clock-in", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-04T12:00:00Z"));
    const { actor, workerId, endId } = await setup(`${date}T22:00:00`, `${nextDate}T06:00:00`);
    await actor.run(ctx => ctx.db.patch(endId!, { workerId: "someone-else" }));
    expect((await actor.query(api.shiftCloseouts.get, { date })).summary.missing_clock_outs).toBe(1);
    await actor.run(async ctx => {
      await ctx.db.patch(endId!, { workerId });
      await ctx.db.insert("attendance", { workerId, eventType: "clock_in", timestamp: `${nextDate}T05:00:00`, synced: true });
    });
    expect((await actor.query(api.shiftCloseouts.get, { date })).summary.missing_clock_outs).toBe(1);
  });

  it("uses effective neighboring punches, including corrections and reversals", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-04T12:00:00Z"));
    const { actor, workerId, endId } = await setup(`${date}T22:00:00`, `${nextDate}T06:00:00`);
    const correctionId = await actor.run(ctx => ctx.db.insert("attendanceCorrections", {
      date: nextDate, workerId, action: "void_event", originalAttendanceId: endId!, reason: "Review", createdAt: date, updatedAt: date,
    }));
    expect((await actor.query(api.shiftCloseouts.get, { date })).summary.missing_clock_outs).toBe(1);
    await actor.run(ctx => ctx.db.insert("attendanceCorrections", {
      date: nextDate, workerId, action: "add_clock_out", eventType: "clock_out", correctedTimestamp: `${nextDate}T06:00:00`,
      reason: "Verified exit", createdAt: date, updatedAt: date,
    }));
    expect((await actor.query(api.shiftCloseouts.get, { date })).summary.missing_clock_outs).toBe(0);
    await actor.run(async ctx => {
      const userId = (await ctx.db.query("users").collect())[0]._id;
      await ctx.db.insert("attendanceCorrectionReversals", { correctionId, requestId: "restore-exit", date: nextDate, workerId, reason: "Restore", actorUserId: userId, createdAt: date });
    });
    // Restored raw exit plus synthetic exit: a duplicate still needs review.
    expect((await actor.query(api.shiftExceptions.summary, { date: nextDate })).exceptions).toMatchObject([{ type: "scan_sequence", severity: "warning" }]);
    expect((await actor.query(api.shiftCloseouts.get, { date })).summary.missing_clock_outs).toBe(0);
  });
});

it("uses the shared Chicago timestamp resolver for DST and invalid wall times", () => {
  const clock = createShiftClock();
  expect(clock.isPlausibleShift({ timestamp: "2026-03-08T02:30:00" }, { timestamp: "2026-03-08T06:00:00" })).toBe(false);
  expect(clock.instantMs({ timestamp: "2026-11-01T01:30:00" })).toBe(Date.parse("2026-11-01T06:30:00Z"));
  expect(clock.instantMs({ timestamp: "2026-11-01T01:30:00", chronologicalKey: "2026-11-01T07:30:00." })).toBe(Date.parse("2026-11-01T07:30:00Z"));
});
