/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const date = "2026-09-01";
const createdAt = `${date}T06:00:00`;

async function setup() {
  const test = convexTest(schema, modules);
  const userId = await test.run(async (ctx) => {
    const id = await ctx.db.insert("users", { email: "admin@example.com" });
    await ctx.db.insert("portalMembers", { userId: id, role: "admin", active: true, createdAt });
    return id;
  });
  const actor = test.withIdentity({ subject: userId });
  const worker = (active = true) => test.run((ctx) => ctx.db.insert("workers", {
    name: "Worker", department: "Operations", enrolledAt: createdAt, active,
  }));
  const scan = (workerId: string, eventType: string, time: string) => test.run((ctx) =>
    ctx.db.insert("attendance", { workerId, eventType, timestamp: `${date}T${time}:00`, synced: true }));
  return { test, actor, worker, scan };
}

const emptyStats = { totalWorkers: 0, clockedIn: 0, clockedOut: 0, notArrived: 0, avgArrival: null };

describe("stats active worker population", () => {
  it("returns zero counts and no average for an empty roster", async () => {
    const { actor } = await setup();
    expect(await actor.query(api.stats.get, { date })).toMatchObject(emptyStats);
  });

  it("excludes a deactivated worker while preserving their historical scans", async () => {
    const { actor, worker, scan } = await setup();
    const id = await worker();
    await scan(id, "clock_in", "07:00");
    expect(await actor.query(api.stats.get, { date })).toMatchObject({ totalWorkers: 1, clockedIn: 1, avgArrival: "07:00" });

    await actor.mutation(api.workers.remove, { id });

    expect(await actor.query(api.stats.get, { date })).toMatchObject(emptyStats);
    expect(await actor.query(api.attendance.list, { date, includeCorrections: false })).toHaveLength(1);
    expect(await actor.query(api.attendance.list, { date })).toHaveLength(1);
  });

  it("uses only active workers for status and the average of each worker's first arrival", async () => {
    const { actor, worker, scan } = await setup();
    const present = await worker();
    const left = await worker();
    await worker(); // Has not arrived.
    const inactive = await worker(false);
    await scan(present, "clock_in", "08:00");
    await scan(present, "clock_out", "09:00");
    await scan(present, "clock_in", "10:00");
    await scan(left, "clock_in", "09:00");
    await scan(left, "clock_out", "17:00");
    await scan(inactive, "clock_in", "04:00");
    await scan(inactive, "clock_out", "05:00");
    await scan("unknown-worker", "clock_in", "03:00");

    expect(await actor.query(api.stats.get, { date })).toMatchObject({
      totalWorkers: 3, clockedIn: 1, clockedOut: 1, notArrived: 1, avgArrival: "08:30",
    });
  });

  it("applies additions and voids before summarizing the active population", async () => {
    const { test, actor, worker, scan } = await setup();
    const active = await worker();
    const voided = await worker();
    const inactive = await worker(false);
    const originalAttendanceId = await scan(voided, "clock_in", "06:00");
    await test.run(async (ctx) => {
      for (const [workerId, time] of [[active, "08:00"], [inactive, "04:00"]]) {
        await ctx.db.insert("attendanceCorrections", {
          date, workerId, action: "add_clock_in", eventType: "clock_in",
          correctedTimestamp: `${date}T${time}:00`, reason: "Missed scan", createdAt, updatedAt: createdAt,
        });
      }
      await ctx.db.insert("attendanceCorrections", {
        date, workerId: voided, action: "void_event", originalAttendanceId,
        reason: "Incorrect scan", createdAt, updatedAt: createdAt,
      });
    });

    expect(await actor.query(api.stats.get, { date })).toMatchObject({
      totalWorkers: 2, clockedIn: 1, clockedOut: 0, notArrived: 1, avgArrival: "08:00",
    });
    const history = await actor.query(api.attendance.list, { date });
    expect(history).toHaveLength(2);
    expect(history.map((row) => row.worker_id)).toContain(inactive);
  });
});
