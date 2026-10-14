import { writeRosterWorker } from "./rosterSequence";
import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

export const run = internalMutation({
  args: {},
  returns: v.object({
    seeded: v.boolean(),
    reason: v.optional(v.string()),
    workers: v.optional(v.number()),
  }),
  handler: async (ctx) => {
    // Check if already seeded
    const existing = await ctx.db.query("workers").first();
    if (existing) return { seeded: false, reason: "already has data" };

    const now = new Date();
    const today = now.toISOString().split("T")[0];

    const workerIds: string[] = [];
    const workers = [
      { name: "Marcus Johnson", department: "Assembly" },
      { name: "Sarah Chen", department: "Quality Control" },
      { name: "Diego Rivera", department: "Welding" },
      { name: "Aisha Patel", department: "Packaging" },
      { name: "Tommy Krueger", department: "Assembly" },
    ];

    for (const w of workers) {
      const id = await writeRosterWorker(ctx, {
        name: w.name,
        department: w.department,
        enrolledAt: now.toISOString(),
        active: true,
      });
      workerIds.push(id);
    }

    // Default schedule
    await ctx.db.insert("schedules", {
      name: "Default Mon-Fri",
      days: "[1,2,3,4,5]",
      startTime: "06:00",
      endTime: "14:30",
      active: true,
      createdAt: now.toISOString(),
    });

    // Kiosks
    const entryKioskId = await ctx.db.insert("kiosks", {
      name: "Main Entry",
      kioskId: "kiosk-entry-1",
      type: "entry",
      location: "Building A Front",
      active: true,
    });
    const exitKioskId = await ctx.db.insert("kiosks", {
      name: "Main Exit",
      kioskId: "kiosk-exit-1",
      type: "exit",
      location: "Building A Rear",
      active: true,
    });

    // Sample gatekeeper records
    const clockInTimes = ["05:52", "06:01", "05:48"];
    for (let i = 0; i < 3; i++) {
      await ctx.db.insert("attendance", {
        workerId: workerIds[i],
        eventType: "clock_in",
        kioskId: entryKioskId,
        timestamp: `${today}T${clockInTimes[i]}:00.000Z`,
        synced: true,
      });
    }
    // Diego clocked out
    await ctx.db.insert("attendance", {
      workerId: workerIds[2],
      eventType: "clock_out",
      kioskId: exitKioskId,
      timestamp: `${today}T12:30:00.000Z`,
      synced: true,
    });

    return { seeded: true, workers: workerIds.length };
  },
});
