/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { findActiveKioskByIdentifier } from "./kioskLookup";
import schema from "./schema";
import { list as listAttendance } from "./attendance";
import { buildShiftExceptions } from "./shiftExceptions";

const modules = import.meta.glob("./**/*.ts");
const lastSync = "2026-09-15T12:00:00Z";

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Admin" });
    await ctx.db.insert("portalMembers", { userId, role: "admin", active: true, createdAt: lastSync });
    const workerId = await ctx.db.insert("workers", { name: "Worker", department: "Operations", active: true, enrolledAt: lastSync });
    const scheduleId = await ctx.db.insert("schedules", { name: "Day shift", days: "1,2,3,4,5", startTime: "08:00", endTime: "17:00", active: true, createdAt: lastSync });
    const kioskId = await ctx.db.insert("kiosks", { name: "Front Entrance", kioskId: "pi-entry", type: "pi", location: "Lobby", active: true });
    const inactiveId = await ctx.db.insert("kiosks", { name: "Retired", kioskId: "old-entry", type: "pi", location: "Lobby", active: false });
    return { userId, workerId, scheduleId, kioskId, inactiveId };
  });
  return { t, admin: t.withIdentity({ subject: ids.userId }), ...ids };
}

describe("kiosk identity resolution", () => {
  it("does not attribute attendance or patch heartbeats using worker/schedule IDs", async () => {
    const { t, admin, workerId, scheduleId } = await setup();
    for (const kioskId of [workerId, scheduleId]) {
      const before = await t.run((ctx) => ctx.db.get(kioskId));
      await t.mutation(internal.attendance.createFromHttp, {
        workerId, kioskId, eventType: "clock_in", timestamp: "2026-09-15T08:00:00",
        idempotencyKey: kioskId,
      });
      expect(await t.mutation(internal.kiosks.updateLastSyncFromHttp, {
        kioskId, lastSync, health: { cameraOk: true, reportedAt: lastSync },
      })).toEqual({ updated: false });
      expect(await t.run((ctx) => ctx.db.get(kioskId))).toEqual(before);
    }
    for (const includeCorrections of [false, true]) {
      const attendance = await admin.query(api.attendance.list, { date: "2026-09-15", includeCorrections });
      expect(attendance).toHaveLength(2);
      expect(attendance.every((row) => row.kiosk_name === null)).toBe(true);
    }
  });

  it("accepts active kiosk document IDs, configured aliases, and names", async () => {
    const { t, kioskId } = await setup();
    for (const identifier of [kioskId, " pi-entry ", "PI-ENTRY", " front ENTRANCE "]) {
      expect(await t.mutation(internal.kiosks.updateLastSyncFromHttp, { kioskId: identifier, lastSync })).toEqual({ updated: true });
      expect(await t.run((ctx) => findActiveKioskByIdentifier(ctx, identifier))).toMatchObject({ _id: kioskId });
    }
    expect(await t.run((ctx) => ctx.db.get(kioskId))).toMatchObject({ lastSync });
  });

  it("ignores inactive kiosks, missing IDs, and blank input", async () => {
    const { t, inactiveId } = await setup();
    for (const identifier of [inactiveId, "Retired", "old-entry", "missing", " ", null, undefined]) {
      expect(await t.run((ctx) => findActiveKioskByIdentifier(ctx, identifier))).toBeNull();
    }
  });

  it("still resolves an explicit alias that happens to look like another table's ID", async () => {
    const { t, workerId, kioskId } = await setup();
    await t.run((ctx) => ctx.db.patch(kioskId, { kioskId: workerId }));
    expect(await t.run((ctx) => findActiveKioskByIdentifier(ctx, workerId))).toMatchObject({ _id: kioskId });
  });

  it.each(["name", "kioskId"] as const)("fails closed on legacy cross-field or duplicate %s aliases", async (field) => {
    const { t, kioskId } = await setup();
    const duplicateId = await t.run((ctx) => ctx.db.insert("kiosks", {
      name: "Other entrance", kioskId: "other-entry", type: "pi", location: "", active: true,
      [field]: " PI-ENTRY ",
    }));
    expect(await t.mutation(internal.kiosks.updateLastSyncFromHttp, { kioskId: "pi-entry", lastSync })).toEqual({ updated: false });
    for (const id of [kioskId, duplicateId]) {
      expect(await t.run((ctx) => ctx.db.get(id))).not.toHaveProperty("lastSync");
    }
    // Explicit document identity remains usable for repairing legacy ambiguity.
    expect(await t.mutation(internal.kiosks.updateLastSyncFromHttp, { kioskId, lastSync })).toEqual({ updated: true });
    await t.run((ctx) => ctx.db.patch(duplicateId, { active: false }));
    expect(await t.mutation(internal.kiosks.updateLastSyncFromHttp, { kioskId: "pi-entry", lastSync })).toEqual({ updated: true });
  });

  it("fails closed for alias resolution if the fleet exceeds the bounded scan", async () => {
    const { t, kioskId } = await setup();
    await t.run(async (ctx) => {
      for (let index = 0; index < 1000; index++) {
        await ctx.db.insert("kiosks", { name: `Kiosk ${index}`, type: "pi", location: "", active: true });
      }
    });
    expect(await t.run((ctx) => findActiveKioskByIdentifier(ctx, "pi-entry"))).toBeNull();
    expect(await t.run((ctx) => findActiveKioskByIdentifier(ctx, kioskId))).toMatchObject({ _id: kioskId });
  });
});


it("reads the fleet once per attendance or exception query across different aliases", async () => {
  const { t, admin, workerId } = await setup();
  await t.run(async (ctx) => {
    for (const kioskId of ["pi-entry", "Front Entrance", "missing-entry"]) {
      await ctx.db.insert("attendance", { workerId, kioskId, eventType: "clock_in", timestamp: "2026-09-15T08:00:00", synced: true });
      await ctx.db.insert("recognitionAttempts", {
        kioskId, timestamp: "2026-09-15T08:00:00", faceDetected: true, decision: "near_miss", threshold: 0.5,
        reviewed: false, createdAt: lastSync,
      });
    }
  });
  await admin.run(async (ctx) => {
    const query = vi.spyOn(ctx.db, "query");
    try {
      const handler = (listAttendance as unknown as {
        _handler: (ctx: unknown, args: { date: string }) => Promise<unknown[]>;
      })._handler;
      expect(await handler(ctx, { date: "2026-09-15" })).toHaveLength(3);
      expect(query.mock.calls.filter(([table]) => table === "kiosks")).toHaveLength(1);
      query.mockClear();
      expect((await buildShiftExceptions(ctx, "2026-09-15")).filter((item) => item.type === "recognition_review")).toHaveLength(3);
      expect(query.mock.calls.filter(([table]) => table === "kiosks")).toHaveLength(1);
    } finally {
      query.mockRestore();
    }
  });
});
