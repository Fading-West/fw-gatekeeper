/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import { listEffectiveAttendanceByFactoryDates, listEffectiveAttendanceByTimestampRange } from "./attendance";
import { createShiftClock, MAX_PLAUSIBLE_SHIFT_HOURS, pairShiftEvents } from "./attendanceShifts";
import { getFactoryLocalDateKey, getNextFactoryLocalDateKey } from "./localDate";
import schema from "./schema";
import { buildShiftExceptions } from "./shiftExceptions";

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

  async function setSchedule(actor: Awaited<ReturnType<typeof setup>>["actor"], startTime: string, endTime: string) {
    await actor.run(async ctx => {
      const schedule = (await ctx.db.query("schedules").collect())[0];
      await ctx.db.patch(schedule._id, { startTime, endTime });
    });
  }

  it("keeps the one-tap scheduled-end clock-out for a day shift still open after its end", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${date}T22:00:00Z`)); // 17:00 Central, 9 h after clock-in
    const { actor } = await setup(`${date}T08:00:00`, null);
    await setSchedule(actor, "06:00", "14:30");
    const [exception] = (await actor.query(api.shiftExceptions.summary, { date })).exceptions
      .filter(row => row.type === "missing_clock_out");
    expect(exception).toMatchObject({
      severity: "warning",
      description: "Night Worker last scanned in at 08:00 and has no clock-out after the 14:30 scheduled end.",
      suggested_resolution: { action: "add_clock_out", corrected_time: "14:30", can_apply: true },
    });
    expect((await actor.query(api.shiftCloseouts.get, { date })).summary.missing_clock_outs).toBe(1);
  });

  it.each([
    // (a) clock-in at/after the scheduled end: the end cannot be its exit.
    ["06:00", "14:30", "15:00", `${date}T22:00:00Z`, "after the 14:30 scheduled end"],
    // (b) 15:00 + 9.5 h scheduled duration reaches the next date.
    ["14:00", "23:30", "15:00", `${nextDate}T04:45:00Z`, "after the 23:30 scheduled end"],
    // (b) a schedule truncated at midnight still uses the 8-hour standard shift.
    ["17:00", "20:00", "17:00", `${nextDate}T02:00:00Z`, "after the 20:00 scheduled end"],
  ])("treats a %s-%s shift entered at %s as possibly overnight while within 16 hours", async (startTime, endTime, clockIn, now, endText) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(now));
    const { actor } = await setup(`${date}T${clockIn}:00`, null);
    await setSchedule(actor, startTime, endTime);
    expect((await actor.query(api.shiftExceptions.summary, { date })).exceptions
      .filter(row => row.type === "missing_clock_out")).toMatchObject([{
      description: expect.stringMatching(new RegExp(`clocked in at ${clockIn}.*${endText}.*may still be in progress`)),
      suggested_resolution: { action: "review_only", can_apply: false, corrected_time: null },
    }]);
  });

  it("never suggests a scheduled-end clock-out that precedes the clock-in, even after 16 hours", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${nextDate}T13:00:00Z`)); // D+1 08:00 Central, 17 h later
    const { actor } = await setup(`${date}T15:00:00`, null);
    await setSchedule(actor, "06:00", "14:30");
    const [exception] = (await actor.query(api.shiftExceptions.summary, { date })).exceptions
      .filter(row => row.type === "missing_clock_out");
    expect(exception.description).toContain("scheduled end precedes the clock-in");
    expect(exception.description).not.toContain("in progress");
    expect(exception.suggested_resolution).toMatchObject({ action: "review_only", can_apply: false, corrected_time: null });
  });

  it("reads attendance for D-1..D+1 with one bounded timestamp scan and one correction range", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-04T12:00:00Z"));
    const { actor } = await setup(`${date}T22:00:00`, `${nextDate}T06:00:00`);
    const reads: { table: string; index: string; bounds: unknown[][] }[] = [];
    const bind = (target: any, prop: PropertyKey) => {
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    };
    const recordBounds = (builder: any, bounds: unknown[][]): any => new Proxy(builder, {
      get: (target, prop) => typeof prop === "string" && ["eq", "gt", "gte", "lt", "lte"].includes(prop)
        ? (...args: unknown[]) => { bounds.push([prop, ...args]); return recordBounds(target[prop](...args), bounds); }
        : bind(target, prop),
    });
    const exceptions = await actor.run(async ctx => {
      const db = new Proxy(ctx.db, { get: (target, prop) => prop !== "query" ? bind(target, prop) : (table: any) =>
        new Proxy(target.query(table), { get: (query, queryProp) => queryProp !== "withIndex" ? bind(query, queryProp) : (index: string, build?: any) => {
          const read = { table, index, bounds: [] as unknown[][] };
          reads.push(read);
          return query.withIndex(index, build && ((q: any) => build(recordBounds(q, read.bounds))));
        } }) });
      return await buildShiftExceptions({ ...ctx, db }, date);
    });
    expect(exceptions).toEqual([]);
    // Before: three per-date helpers each scanned their date +/- 1 (9 days of
    // prefixes). Now: one scan of D-1..D+1 plus the same one-date margin.
    expect(reads.filter(read => read.table === "attendance")).toEqual([{
      table: "attendance", index: "by_timestamp",
      bounds: [["gte", "timestamp", "2026-09-01"], ["lt", "timestamp", "2026-09-06"]],
    }]);
    expect(reads.filter(read => read.table === "attendanceCorrections")).toEqual([{
      table: "attendanceCorrections", index: "by_date",
      bounds: [["gte", "date", "2026-09-02"], ["lte", "date", "2026-09-04"]],
    }]);
  });

  it("partitions the multi-date read exactly like per-date effective attendance", async () => {
    const { actor, workerId, startId } = await setup(`${date}T22:00:00`, `${nextDate}T06:00:00`);
    const byDate = await actor.run(async ctx => {
      const userId = (await ctx.db.query("users").collect())[0]._id;
      for (const timestamp of [
        "2026-09-01T23:30:00", "2026-09-01T21:00:00-10:00", "2026-09-02T04:30:00Z", "2026-09-02T00:15:00-10:00", "2026-09-02T23:59:59",
        "2026-09-03T04:59:59Z", "2026-09-04T05:00:00Z", "2026-09-05T03:00:00+02:00", "2026-09-05T05:30:00Z", "2026-09-05T08:00:00",
      ]) await ctx.db.insert("attendance", { workerId, eventType: "clock_in", timestamp, synced: true });
      const add = (correctionDate: string, correctedTimestamp: string) => ctx.db.insert("attendanceCorrections", {
        date: correctionDate, workerId, action: "add_clock_out", eventType: "clock_out", correctedTimestamp,
        reason: "Verified", createdAt: date, updatedAt: date,
      });
      await add("2026-09-02", "2026-09-02T17:00:00");
      await add("2026-09-04", "2026-09-04T07:00:00");
      const reversedId = await add(nextDate, `${nextDate}T08:00:00`);
      await ctx.db.insert("attendanceCorrectionReversals", { correctionId: reversedId, requestId: "r", date: nextDate, workerId, reason: "Wrong", actorUserId: userId, createdAt: date });
      // A void filed under another date only applies to that date's punches.
      await ctx.db.insert("attendanceCorrections", { date: nextDate, workerId, action: "void_event", originalAttendanceId: startId!, reason: "Wrong day", createdAt: date, updatedAt: date });
      const combined = await listEffectiveAttendanceByFactoryDates(ctx, "2026-09-02", nextDate);
      const separate = await Promise.all(["2026-09-02", date, nextDate].map(day => listEffectiveAttendanceByTimestampRange(ctx, day)));
      return { combined: [...combined.entries()], separate };
    });
    expect(byDate.combined.map(([day]) => day)).toEqual(["2026-09-02", date, nextDate]);
    expect(byDate.combined.map(([, rows]) => rows)).toEqual(byDate.separate);
    expect(byDate.separate.map(rows => rows.length)).toEqual([5, 1, 4]);
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
