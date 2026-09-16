/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

// Thursday, so a Mon-Fri schedule applies. Central Daylight Time (UTC-5).
const DATE = "2026-09-03";

async function seedShift() {
  const t = convexTest(schema, modules);
  const adminId = await t.run(async (ctx) => {
    const now = new Date().toISOString();
    const userId = await ctx.db.insert("users", { email: "admin@example.com" });
    await ctx.db.insert("portalMembers", { userId, role: "admin", active: true, createdAt: now });
    const workerId = await ctx.db.insert("workers", {
      name: "Evening Worker",
      department: "Operations",
      enrolledAt: now,
      active: true,
    });
    await ctx.db.insert("schedules", {
      name: "Second shift",
      days: "[1,2,3,4,5]",
      startTime: "06:00",
      endTime: "22:00",
      active: true,
      createdAt: now,
    });
    await ctx.db.insert("attendance", {
      workerId: String(workerId),
      eventType: "clock_in",
      kioskId: "kiosk-entry-1",
      timestamp: `${DATE}T07:00:00`,
      synced: true,
    });
    return userId;
  });
  return t.withIdentity({ subject: adminId });
}

function missingClockOuts(payload: any) {
  return payload.exceptions.filter((exception: any) => exception.type === "missing_clock_out");
}

describe("missing clock-out timing uses the factory-local day", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not flag a worker mid-shift at 20:30 Central even though the UTC date has rolled over", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 2026-09-04T01:30:00Z is still 2026-09-03 20:30 in America/Chicago.
    vi.setSystemTime(new Date("2026-09-04T01:30:00.000Z"));

    const admin = await seedShift();
    const payload = await admin.query(api.shiftExceptions.summary, { date: DATE });

    expect(missingClockOuts(payload)).toHaveLength(0);
  });

  it("flags the worker once the factory-local day has actually passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 2026-09-04 09:00 Central.
    vi.setSystemTime(new Date("2026-09-04T14:00:00.000Z"));

    const admin = await seedShift();
    const payload = await admin.query(api.shiftExceptions.summary, { date: DATE });

    expect(missingClockOuts(payload)).toHaveLength(1);
    expect(missingClockOuts(payload)[0]).toMatchObject({ worker_name: "Evening Worker", severity: "warning" });
  });

  it("flags a normal morning arrival after the scheduled end on the same day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-04T03:30:00.000Z"));
    const admin = await seedShift();
    const payload = await admin.query(api.shiftExceptions.summary, { date: DATE });
    expect(missingClockOuts(payload)).toHaveLength(1);
  });

  it("uses the factory day when no explicit date is supplied", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-04T01:30:00.000Z"));
    const admin = await seedShift();
    const payload = await admin.query(api.shiftExceptions.summary, {});
    expect(payload.date).toBe(DATE);
    expect(missingClockOuts(payload)).toHaveLength(0);
    expect(await admin.query(api.attendance.list, {})).toHaveLength(1);
    expect(await admin.query(api.stats.get, {})).toMatchObject({ clockedIn: 1 });
  });

  it.each([
    ["2026-09-03T10:00:00.000Z", 0], // 05:00 before the shift
    ["2026-09-03T11:00:00.000Z", 0], // exactly the 06:00 start
    ["2026-09-03T11:01:00.000Z", 1], // after the start
    ["2026-09-02T18:00:00.000Z", 0], // a future shift
    ["2026-09-04T18:00:00.000Z", 1], // a past shift
  ])("only raises missing arrivals when due at %s", async (now, expected) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(now));
    const admin = await seedShift();
    await admin.run(async (ctx) => {
      for (const event of await ctx.db.query("attendance").collect()) await ctx.db.delete(event._id);
    });
    const payload = await admin.query(api.shiftExceptions.summary, { date: DATE });
    expect(payload.exceptions.filter((row: any) => row.type === "missing_arrival")).toHaveLength(expected);
  });
});


describe("legacy unsupported schedules", () => {
  afterEach(() => vi.useRealTimers());
  it.each([true, false])("blocks schedule-based corrections with clock-in=%s", async (hasClockIn) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-04T04:00:00Z")); // 23:00 Central
    const admin = await seedShift();
    await admin.run(async ctx => {
      const schedule = (await ctx.db.query("schedules").collect())[0];
      await ctx.db.patch(schedule._id, { startTime: "22:00", endTime: "06:00", department: "Operations" });
      await ctx.db.insert("schedules", { name: "General shift", days: "[1,2,3,4,5]", startTime: "06:00", endTime: "14:30", active: true, createdAt: new Date().toISOString() });
      for (const event of await ctx.db.query("attendance").collect()) {
        if (hasClockIn) await ctx.db.patch(event._id, { timestamp: `${DATE}T22:00:00` });
        else await ctx.db.delete(event._id);
      }
    });
    const payload = await admin.query(api.shiftExceptions.summary, { date: DATE });
    expect(payload.exceptions).toHaveLength(1);
    expect(payload.exceptions[0]).toMatchObject({ type: "unsupported_schedule", severity: "critical", scheduled_start: "22:00", suggested_resolution: { action: "review_only", can_apply: false, corrected_time: null, href: "/schedules" } });
  });
});

describe("recognition review completion", () => {
  afterEach(() => vi.useRealTimers());

  it.each(["near_miss", "rejected_unknown", "accepted"])("closes %s reviews and honors the latest explicit reopen", async (decision) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${DATE}T15:00:00Z`));
    const admin = await seedShift();
    const id = await admin.run(ctx => ctx.db.insert("recognitionAttempts", {
      timestamp: `${DATE}T09:00:00`, kioskId: "entry", faceDetected: true,
      decision, scoreMargin: 0.01, threshold: 0.3, reviewed: false, createdAt: `${DATE}T14:00:00Z`,
    }));
    const exceptionKey = `${DATE}:recognition_review:${id}`;
    const status = async () => (await admin.query(api.shiftExceptions.summary, { date: DATE })).exceptions.find(row => row.key === exceptionKey);
    expect(await status()).toMatchObject({ status: "open" });
    await admin.mutation(api.shiftExceptions.review, { exceptionKey, date: DATE, type: "recognition_review", status: "open" });
    for (const label of ["confirmed", "corrected", "ignored"]) {
      vi.advanceTimersByTime(1000);
      await admin.mutation(api.recognitionAttempts.updateReview, { id, reviewedLabel: label, reviewedNote: `Reviewed ${label}` });
      expect(await status()).toMatchObject({ status: label === "ignored" ? "ignored" : "reviewed", review_note: `Reviewed ${label}` });
    }
    vi.advanceTimersByTime(1000);
    await admin.mutation(api.shiftExceptions.review, { exceptionKey, date: DATE, type: "recognition_review", status: "open", note: "Recheck" });
    expect(await status()).toMatchObject({ status: "open", review_note: "Recheck" });
    expect((await admin.query(api.shiftCloseouts.get, { date: DATE })).summary.recognition_reviews).toBe(1);
    expect((await admin.query(api.shiftBriefing.summary, { date: DATE })).summary.recognition_reviews).toBe(1);
    vi.advanceTimersByTime(1000);
    await admin.mutation(api.recognitionAttempts.updateReview, { id, reviewedLabel: "confirmed" });
    expect(await status()).toMatchObject({ status: "reviewed" });
    expect((await admin.query(api.shiftCloseouts.get, { date: DATE })).summary.recognition_reviews).toBe(0);
    expect((await admin.query(api.shiftBriefing.summary, { date: DATE })).summary.recognition_reviews).toBe(0);
    vi.advanceTimersByTime(1000);
    await admin.mutation(api.shiftExceptions.review, { exceptionKey, date: DATE, type: "recognition_review", status: "resolved" });
    expect(await status()).toMatchObject({ status: "resolved" });
    vi.advanceTimersByTime(1000);
    await admin.mutation(api.recognitionAttempts.updateReview, { id, reviewed: false });
    expect(await status()).toMatchObject({ status: "open", reviewed_at: null });
  });
});

describe("scan sequence event identity", () => {
  async function seedRepeatedScans() {
    const admin = await seedShift();
    const events = await admin.run(async ctx => {
      const first = (await ctx.db.query("attendance").collect())[0];
      const ids = [];
      for (let i = 0; i < 3; i++) {
        ids.push(await ctx.db.insert("attendance", {
          workerId: first.workerId, eventType: "clock_in", timestamp: `${DATE}T08:00:00`, synced: true,
        }));
      }
      return { ids, workerId: first.workerId };
    });
    const sequences = async () => (await admin.query(api.shiftExceptions.summary, { date: DATE })).exceptions.filter(row => row.type === "scan_sequence");
    return { admin, sequences, ...events };
  }

  it("reviews same-time scans independently and keeps keys when another scan is voided", async () => {
    const { admin, sequences, ids, workerId } = await seedRepeatedScans();
    const before = await sequences();
    expect(before).toHaveLength(3);
    expect(new Set(before.map(row => row.key)).size).toBe(3);
    const selected = before.find(row => row.attendance_id === ids[1])!;
    expect(selected.suggested_resolution.source_exception_key).toBe(selected.key);
    expect(selected.links.activity_log).toContain(`attendance_id=${ids[1]}`);
    await admin.mutation(api.shiftExceptions.review, {
      exceptionKey: selected.key, date: DATE, type: "scan_sequence", status: "ignored", note: "Reviewed this scan only",
    });
    expect((await sequences()).filter(row => row.status === "ignored").map(row => row.attendance_id)).toEqual([ids[1]]);
    await admin.run(ctx => ctx.db.insert("attendanceCorrections", {
      date: DATE, workerId, action: "void_event", originalAttendanceId: ids[0], reason: "Duplicate",
      createdAt: `${DATE}T18:00:00Z`, updatedAt: `${DATE}T18:00:00Z`,
    }));
    const after = await sequences();
    expect(after).toHaveLength(2);
    expect(after.find(row => row.attendance_id === ids[1])).toMatchObject({ key: selected.key, status: "ignored" });
    expect(after.find(row => row.attendance_id === ids[2])).toMatchObject({ status: "open" });
  });

  it("does not reuse ambiguous legacy reviews even after all but one same-time scan is voided", async () => {
    const { admin, sequences, ids, workerId } = await seedRepeatedScans();
    const legacyKey = `${DATE}:scan_sequence:${workerId}:${DATE}T08:00:00:clock_in`;
    await admin.mutation(api.shiftExceptions.review, {
      exceptionKey: legacyKey, date: DATE, type: "scan_sequence", status: "ignored",
    });
    expect((await sequences()).every(row => row.status === "open")).toBe(true);
    await admin.run(async ctx => {
      for (const id of ids.slice(0, 2)) await ctx.db.insert("attendanceCorrections", {
        date: DATE, workerId, action: "void_event", originalAttendanceId: id, reason: "Duplicate",
        createdAt: `${DATE}T18:00:00Z`, updatedAt: `${DATE}T18:00:00Z`,
      });
    });
    expect(await sequences()).toMatchObject([{ attendance_id: ids[2], status: "open" }]);
    expect(await admin.run(ctx => ctx.db.query("exceptionReviews").collect())).toMatchObject([{ exceptionKey: legacyKey, status: "ignored" }]);
  });

  it("gives synthetic correction events their own stable review keys", async () => {
    const { admin, sequences, workerId } = await seedRepeatedScans();
    const correctionIds = await admin.run(async ctx => {
      const ids = [];
      for (let i = 0; i < 2; i++) ids.push(await ctx.db.insert("attendanceCorrections", {
        date: DATE, workerId, action: "add_clock_in", eventType: "clock_in", correctedTimestamp: `${DATE}T09:00:00`,
        reason: "Verified scan", createdAt: `${DATE}T18:00:00Z`, updatedAt: `${DATE}T18:00:00Z`,
      }));
      return ids;
    });
    const keys = correctionIds.map(id => `${DATE}:scan_sequence:${workerId}:correction:${id}`);
    expect((await sequences()).filter(row => keys.includes(row.key))).toHaveLength(2);
    await admin.mutation(api.shiftExceptions.review, {
      exceptionKey: keys[0], date: DATE, type: "scan_sequence", status: "reviewed",
    });
    // Same instant, different timestamp representation must not change source identity.
    await admin.run(ctx => ctx.db.patch(correctionIds[0], { correctedTimestamp: `${DATE}T14:00:00Z` }));
    const after = await sequences();
    expect(after.find(row => row.key === keys[0])).toMatchObject({ attendance_id: null, status: "reviewed" });
    expect(after.find(row => row.key === keys[1])).toMatchObject({ attendance_id: null, status: "open" });
  });
});
