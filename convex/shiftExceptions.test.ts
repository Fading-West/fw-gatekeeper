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
