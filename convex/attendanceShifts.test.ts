/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import { createShiftClock, MAX_PLAUSIBLE_SHIFT_HOURS, pairShiftEvents } from "./attendanceShifts";
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

  it("pairs consecutive overnight shifts and a same-day shift independently", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-06T12:00:00Z"));
    const { actor, workerId } = await setup(`${date}T22:00:00`, `${nextDate}T06:00:00`);
    await actor.run(async ctx => {
      for (const [day, time, eventType] of [
        [nextDate, "09:00", "clock_in"], [nextDate, "17:00", "clock_out"],
        [nextDate, "22:00", "clock_in"], ["2026-09-05", "06:00", "clock_out"],
        ["2026-09-05", "22:00", "clock_in"], ["2026-09-06", "06:00", "clock_out"],
      ]) await ctx.db.insert("attendance", { workerId, eventType, timestamp: `${day}T${time}:00`, synced: true });
    });
    for (const selectedDate of [date, nextDate, "2026-09-05", "2026-09-06"]) {
      expect((await actor.query(api.shiftExceptions.summary, { date: selectedDate })).exceptions).toEqual([]);
      expect((await actor.query(api.shiftCloseouts.get, { date: selectedDate })).summary.missing_clock_outs).toBe(0);
      expect((await actor.query(api.shiftBriefing.summary, { date: selectedDate })).shift_trust_brief.source_counts.missing_clock_outs).toBe(0);
    }
  });

  it.each(["23:00", "05:00"])("preserves review of a repeated entry at %s with a plausible exit", async time => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-04T12:00:00Z"));
    const { actor, workerId, endId } = await setup(`${date}T22:00:00`, `${nextDate}T06:00:00`);
    const selectedDate = time === "23:00" ? date : nextDate;
    const repeatedId = await actor.run(ctx => ctx.db.insert("attendance", {
      workerId, eventType: "clock_in", timestamp: `${selectedDate}T${time}:00`, synced: true,
    }));
    const exceptions = (await actor.query(api.shiftExceptions.summary, { date: selectedDate })).exceptions;
    expect(exceptions.filter(row => row.type === "scan_sequence")).toMatchObject([{
      attendance_id: repeatedId, severity: "warning",
      suggested_resolution: { action: "review_only", can_apply: false, original_attendance_id: null },
    }]);
    expect(exceptions.some(row => row.attendance_id === endId && row.suggested_resolution.action === "void_event")).toBe(false);
    expect((await actor.query(api.shiftCloseouts.get, { date })).summary.missing_clock_outs).toBe(time === "23:00" ? 0 : 1);
  });

  it("does not suggest adding a clock-out once a plausible later exit exists", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // D+1 15:00 Central: more than 16 hours after the 22:00 entry.
    vi.setSystemTime(new Date("2026-09-04T20:00:00Z"));
    const { actor, workerId } = await setup(`${date}T22:00:00`, null);
    // Control: with no exit evidence, an expired open shift keeps its correction path.
    expect((await actor.query(api.shiftExceptions.summary, { date })).exceptions).toMatchObject([{
      type: "missing_clock_out", suggested_resolution: { action: "add_clock_out", corrected_time: "23:00" },
    }]);
    await actor.run(async ctx => {
      await ctx.db.insert("attendance", { workerId, eventType: "clock_in", timestamp: `${nextDate}T05:00:00`, synced: true });
      await ctx.db.insert("attendance", { workerId, eventType: "clock_out", timestamp: `${nextDate}T06:00:00`, synced: true });
    });
    // The repeated entry across midnight blocks automatic pairing, but the
    // 06:00 exit could still close the 22:00 entry. Inventing a 23:00 exit
    // would cut the paid shift, so only review is offered.
    expect((await actor.query(api.shiftExceptions.summary, { date })).exceptions).toMatchObject([{
      type: "missing_clock_out", severity: "warning", description: expect.stringContaining("later clock-out"),
      suggested_resolution: { action: "review_only", can_apply: false, corrected_time: null },
    }]);
    expect((await actor.query(api.shiftCloseouts.get, { date })).summary.missing_clock_outs).toBe(1);
  });

  it("does not suggest voiding a repeated exit with a plausible entry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-04T13:00:00Z"));
    const { actor, workerId } = await setup(`${date}T22:00:00`, `${nextDate}T06:00:00`);
    const repeatedId = await actor.run(ctx => ctx.db.insert("attendance", {
      workerId, eventType: "clock_out", timestamp: `${nextDate}T07:00:00`, synced: true,
    }));
    expect((await actor.query(api.shiftExceptions.summary, { date: nextDate })).exceptions).toMatchObject([{
      attendance_id: repeatedId, type: "scan_sequence", severity: "warning",
      suggested_resolution: { action: "review_only", can_apply: false },
    }]);
  });

  it("reviews an exit whose plausible entry was consumed on the previous date", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-04T12:00:00Z"));
    const { actor, workerId, endId } = await setup(`${date}T22:00:00`, `${nextDate}T06:00:00`);
    await actor.run(ctx => ctx.db.insert("attendance", {
      workerId, eventType: "clock_out", timestamp: `${date}T23:00:00`, synced: true,
    }));
    expect((await actor.query(api.shiftExceptions.summary, { date: nextDate })).exceptions).toMatchObject([{
      attendance_id: endId, type: "scan_sequence", severity: "critical",
      description: expect.stringContaining("competing scan evidence"),
      suggested_resolution: { action: "review_only", can_apply: false },
    }]);
  });

  it("does not suggest voiding an entry that could close a shorter shift when the retained first entry is overlong", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-03T23:00:00Z"));
    const { actor, workerId } = await setup(`${date}T00:00:00`, `${date}T17:00:00`);
    const repeatedId = await actor.run(ctx => ctx.db.insert("attendance", {
      workerId, eventType: "clock_in", timestamp: `${date}T08:00:00`, synced: true,
    }));
    const exceptions = (await actor.query(api.shiftExceptions.summary, { date })).exceptions;
    expect(exceptions.filter(row => row.type === "scan_sequence")).toHaveLength(2);
    expect(exceptions.find(row => row.attendance_id === repeatedId)?.suggested_resolution.action).toBe("review_only");
    expect(exceptions.some(row => row.suggested_resolution.action === "void_event")).toBe(false);
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

it("protects every punch with a plausible counterpart, including equal instants and already-consumed evidence", () => {
  const clock = createShiftClock();
  const events = [
    { eventType: "clock_in", timestamp: "2026-09-03T22:00:00" },
    { eventType: "clock_out", timestamp: "2026-09-04T00:00:00" },
    { eventType: "clock_in", timestamp: "2026-09-04T00:00:00" },
    { eventType: "clock_out", timestamp: "2026-09-04T06:00:00" },
    { eventType: "clock_out", timestamp: "2026-09-04T07:00:00" },
    { eventType: "clock_in", timestamp: "2026-09-04T09:00:00" },
    { eventType: "clock_out", timestamp: "2026-09-05T01:00:01" },
  ];
  const { plausiblePairEvents } = pairShiftEvents(events, clock);
  for (const event of events) {
    const hasCandidate = events.some(other => event.eventType === "clock_in"
      ? other.eventType === "clock_out" && clock.isPlausibleShift(event, other)
      : other.eventType === "clock_in" && clock.isPlausibleShift(other, event));
    expect(plausiblePairEvents.has(event)).toBe(hasCandidate);
  }
});
