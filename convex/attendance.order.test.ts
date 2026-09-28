/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const date = "2026-11-01";
async function setup(events: Array<[string, string]>, correction = false) {
  const t = convexTest(schema, modules);
  const userId = await t.run(async ctx => {
    const userId = await ctx.db.insert("users", { email: "admin@example.com" });
    await ctx.db.insert("portalMembers", { userId, role: "admin", active: true, createdAt: date });
    const workerId = await ctx.db.insert("workers", {
      name: "Worker", department: "Operations", enrolledAt: date, active: true,
    });
    await ctx.db.insert("schedules", {
      name: "Sunday", days: "[0]", startTime: "01:00", endTime: "03:00", active: true, createdAt: date,
    });
    for (const [index, [eventType, timestamp]] of events.entries()) {
      if (correction && index === events.length - 1) {
        await ctx.db.insert("attendanceCorrections", {
          date, workerId, action: "add_clock_out", eventType: "clock_out", correctedTimestamp: timestamp,
          reason: "Missed scan", createdAt: date, updatedAt: date,
        });
      } else {
        await ctx.db.insert("attendance", { workerId, eventType, timestamp, synced: true });
      }
    }
    return userId;
  });
  return t.withIdentity({ subject: userId });
}

describe("attendance chronological order", () => {
  it.each([false, true])("keeps the later fall-back clock-out last across stats, history and shift consumers (correction=%s)", async correction => {
    const actor = await setup([
      ["clock_in", `${date}T01:45:00-05:00`],
      ["clock_out", `${date}T01:15:00-06:00`],
    ], correction);
    expect(await actor.query(api.stats.get, { date })).toMatchObject({ clockedIn: 0, clockedOut: 1, avgArrival: "01:45" });
    const history = await actor.query(api.attendance.list, { date });
    expect(history.map(row => row.event_type)).toEqual(["clock_out", "clock_in"]);
    expect(history.map(row => row.timestamp)).toEqual([`${date}T01:15:00`, `${date}T01:45:00`]);
    expect(history[0]).not.toHaveProperty("chronologicalKey");
    expect(history.map(row => row.timestamp_utc)).toEqual([`${date}T07:15:00Z`, `${date}T06:45:00Z`]);
    if (!correction) {
      expect((await actor.query(api.attendance.list, { date, includeCorrections: false })).map(row => row.event_type))
        .toEqual(["clock_out", "clock_in"]);
    }
    const exceptions = await actor.query(api.shiftExceptions.summary, { date });
    expect(exceptions.exceptions.filter((row: any) => ["scan_sequence", "missing_clock_out"].includes(row.type))).toEqual([]);
    const briefing = await actor.query(api.shiftBriefing.summary, { date });
    expect(briefing.workers).toMatchObject([{ status: "clocked_out", first_seen: `${date}T01:45:00`, last_seen: `${date}T01:15:00` }]);
  });

  it("uses the first actual arrival when the wall clock repeats", async () => {
    const actor = await setup([
      ["clock_in", `${date}T01:45:00-05:00`],
      ["clock_out", `${date}T01:55:00-05:00`],
      ["clock_in", `${date}T01:15:00-06:00`],
    ]);
    expect(await actor.query(api.stats.get, { date })).toMatchObject({ clockedIn: 1, avgArrival: "01:45" });
    expect((await actor.query(api.shiftBriefing.summary, { date })).workers[0].first_seen).toBe(`${date}T01:45:00`);
  });

  it("preserves sub-millisecond order and display precision across local and offset timestamps", async () => {
    // Insert the later scan first to make storage order an incorrect fallback.
    const actor = await setup([
      ["clock_out", `${date}T09:00:00.123457Z`],
      ["clock_in", `${date}T03:00:00.123456`],
    ]);
    expect(await actor.query(api.stats.get, { date })).toMatchObject({ clockedIn: 0, clockedOut: 1 });
    expect((await actor.query(api.attendance.list, { date })).map(row => row.timestamp))
      .toEqual([`${date}T03:00:00.123457`, `${date}T03:00:00.123456`]);
  });

  it("keeps UTC events on the factory date and interprets legacy local times in Chicago", async () => {
    const actor = await setup([
      ["clock_in", `${date}T23:00:00`],
      ["clock_out", "2026-11-02T05:30:00Z"],
    ]);
    expect(await actor.query(api.stats.get, { date })).toMatchObject({ clockedIn: 0, clockedOut: 1 });
    expect((await actor.query(api.attendance.list, { date })).map(row => row.timestamp))
      .toEqual([`${date}T23:30:00`, `${date}T23:00:00`]);
    expect(await actor.query(api.attendance.list, { date: "2026-11-02" })).toEqual([]);
  });
});
