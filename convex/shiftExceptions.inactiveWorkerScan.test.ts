/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

// Central Daylight Time (UTC-5). 14:00Z is 09:00 at the factory.
const DATE = "2026-09-03";
const NOW = "2026-09-05T15:00:00.000Z";
const ENROLLED = "2026-09-01T12:00:00.000Z";
const REMOVED = "2026-09-03T14:00:00.000Z";

type Setup = Awaited<ReturnType<typeof setup>>;

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const users = {} as Record<"admin" | "enrollment" | "viewer", Id<"users">>;
    for (const role of ["admin", "enrollment", "viewer"] as const) {
      const userId = await ctx.db.insert("users", { email: `${role}@example.com` });
      await ctx.db.insert("portalMembers", { userId, role, active: true, createdAt: ENROLLED });
      users[role] = userId;
    }
    const kioskDocId = await ctx.db.insert("kiosks", {
      name: "Front door", kioskId: "front-1", type: "entry", location: "Entry", active: true,
    });
    const workerId = await ctx.db.insert("workers", {
      name: "Alex Removed", department: "Framing", enrolledAt: ENROLLED, updatedAt: ENROLLED, active: true,
    });
    return { users, kioskDocId, workerId };
  });
  return {
    t,
    ...ids,
    admin: t.withIdentity({ subject: ids.users.admin }),
    enrollment: t.withIdentity({ subject: ids.users.enrollment }),
    viewer: t.withIdentity({ subject: ids.users.viewer }),
  };
}

async function audit(s: Setup, action: string, createdAt: string, details?: Record<string, unknown>, workerId = s.workerId) {
  await s.t.run((ctx) => ctx.db.insert("auditLog", {
    actorUserId: s.users.admin, action, targetTable: "workers", targetId: String(workerId),
    ...(details ? { details: JSON.stringify(details) } : {}), createdAt,
  }));
}

async function deactivate(s: Setup, updatedAt: string | null) {
  await s.t.run((ctx) => ctx.db.patch(s.workerId, { active: false, updatedAt: updatedAt ?? undefined }));
}

// The common audited case: enrolled while audit rows existed, removed at 09:00.
async function removeAt(s: Setup, removedAt = REMOVED) {
  await audit(s, "workers.enroll", ENROLLED);
  await audit(s, "workers.remove", removedAt);
  await deactivate(s, removedAt);
}

async function scan(
  s: Setup,
  timestamp: string,
  options: { eventType?: string; kioskId?: string; workerId?: string } = {},
) {
  return await s.t.run(async (ctx) => String(await ctx.db.insert("attendance", {
    workerId: options.workerId ?? String(s.workerId),
    workerName: "Kiosk Cached Name",
    eventType: options.eventType ?? "clock_in",
    kioskId: options.kioskId ?? "front-1",
    timestamp,
    synced: true,
  })));
}

async function summary(s: Setup, date = DATE) {
  return await s.admin.query(api.shiftExceptions.summary, { date });
}

async function inactiveScans(s: Setup, date = DATE) {
  return (await summary(s, date)).exceptions.filter((exception: any) => exception.type === "inactive_worker_scan");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("inactive worker scan detection", () => {
  it("does not flag an active worker", async () => {
    const s = await setup();
    await audit(s, "workers.enroll", ENROLLED);
    await scan(s, `${DATE}T10:00:00`);
    const payload = await summary(s);
    expect(payload.exceptions).toEqual([]);
  });

  it("raises one open critical exception for a scan after a real Remove", async () => {
    const s = await setup();
    await audit(s, "workers.enroll", ENROLLED);
    await s.t.run((ctx) => ctx.db.patch(s.kioskDocId, { rosterAppliedAt: "2026-09-02T12:00:00.000Z" }));
    vi.setSystemTime(new Date(REMOVED));
    await s.admin.mutation(api.workers.remove, { id: s.workerId });
    vi.setSystemTime(new Date(NOW));
    const attendanceId = await scan(s, `${DATE}T10:15:00`);

    const payload = await summary(s);
    const activityLog = `/log?date=${DATE}&worker_id=${s.workerId}&attendance_id=${attendanceId}`;
    expect(payload.exceptions).toHaveLength(1);
    const [exception] = payload.exceptions;
    expect(exception).toMatchObject({
      key: `${DATE}:inactive_worker_scan:${s.workerId}:${attendanceId}`,
      date: DATE,
      type: "inactive_worker_scan",
      severity: "critical",
      status: "open",
      title: "Alex Removed scanned after being deactivated",
      description: "Alex Removed was deactivated at 2026-09-03 09:00, but kiosk Front door recorded a clock in at 10:15. This kiosk's latest acknowledged roster receipt was issued before the deactivation.",
      worker_id: String(s.workerId),
      worker_name: "Alex Removed",
      department: "Framing",
      kiosk_id: "front-1",
      kiosk_name: "Front door",
      first_seen: `${DATE}T10:15:00`,
      last_seen: `${DATE}T10:15:00`,
      schedule_name: null,
      scheduled_start: null,
      scheduled_end: null,
      event_count: 1,
      attendance_id: attendanceId,
      review_note: null,
      reviewed_at: null,
      links: { activity_log: activityLog, worker: "/workers" },
      suggested_resolution: {
        action: "review_only",
        label: "Review deactivated-worker scan",
        cta: "Review source",
        href: activityLog,
        source_href: activityLog,
        can_apply: false,
        corrected_time: null,
        original_attendance_id: null,
        source_exception_key: exception.key,
      },
    });
    expect(exception.links).toEqual({ activity_log: activityLog, worker: "/workers" });
    expect(exception.suggested_resolution.reason).toContain("Deactivated worker scan:");
    expect(exception.suggested_resolution.disabled_reason).toMatch(/kept as door evidence[\s\S]*restore them through enrollment[\s\S]*audited void only if separate evidence/);
    expect(payload.summary).toMatchObject({ total: 1, open: 1, critical: 1, by_type: { inactive_worker_scan: 1 } });
  });

  it("does not flag a scan recorded before deactivation that synced afterwards", async () => {
    const s = await setup();
    await removeAt(s);
    await scan(s, `${DATE}T08:59:59.999`);
    expect(await inactiveScans(s)).toEqual([]);
  });

  it.each([
    [`${DATE}T09:00:00.499`, false],
    [`${DATE}T09:00:00.4999999`, false],
    [`${DATE}T14:00:00.499Z`, false],
    [`${DATE}T09:00:00.5`, true],
    [`${DATE}T09:00:00.500000`, true],
    [`${DATE}T14:00:00.5Z`, true],
    [`${DATE}T09:00:00.5-05:00`, true],
    [`${DATE}T09:00:00.500001-05:00`, true],
  ])("compares sub-second instants at the boundary: %s flagged=%s", async (timestamp, flagged) => {
    const s = await setup();
    await removeAt(s, "2026-09-03T14:00:00.500Z");
    await scan(s, timestamp);
    expect(await inactiveScans(s)).toHaveLength(flagged ? 1 : 0);
  });

  it("treats UTC and offset timestamps for the same instant identically", async () => {
    const s = await setup();
    await removeAt(s);
    await scan(s, `${DATE}T13:59:59Z`);
    await scan(s, `${DATE}T08:59:59-05:00`);
    const atUtc = await scan(s, `${DATE}T14:00:00Z`);
    const atOffset = await scan(s, `${DATE}T09:00:00-05:00`);
    const flagged = await inactiveScans(s);
    expect(flagged.map((exception: any) => exception.attendance_id).sort()).toEqual([atUtc, atOffset].sort());
    expect(flagged.every((exception: any) => exception.first_seen === `${DATE}T09:00:00`)).toBe(true);
  });

  it("uses the earliest Remove when Remove was repeated", async () => {
    const s = await setup();
    await audit(s, "workers.enroll", ENROLLED);
    await audit(s, "workers.remove", REMOVED);
    await audit(s, "workers.remove", "2026-09-03T16:00:00.000Z");
    await deactivate(s, "2026-09-03T16:00:00.000Z");
    await scan(s, `${DATE}T10:00:00`);
    const [exception] = await inactiveScans(s);
    expect(exception.description).toContain("Alex Removed was deactivated at 2026-09-03 09:00,");
  });

  it("uses the removal after the latest restore", async () => {
    const s = await setup();
    await audit(s, "workers.enroll", ENROLLED);
    await audit(s, "workers.remove", "2026-09-02T14:00:00.000Z");
    await audit(s, "workers.enroll", "2026-09-02T20:00:00.000Z");
    await audit(s, "workers.remove", "2026-09-03T16:00:00.000Z");
    await deactivate(s, "2026-09-03T16:00:00.000Z");
    await scan(s, "2026-09-02T10:00:00"); // first inactive window, later restored
    await scan(s, `${DATE}T10:00:00`); // active again
    const late = await scan(s, `${DATE}T11:30:00`);
    expect(await inactiveScans(s, "2026-09-02")).toEqual([]);
    const flagged = await inactiveScans(s);
    expect(flagged.map((exception: any) => exception.attendance_id)).toEqual([late]);
    expect(flagged[0].description).toContain("was deactivated at 2026-09-03 11:00,");
  });

  it("keeps the original removal time when biometrics are purged later", async () => {
    const s = await setup();
    await removeAt(s);
    await audit(s, "workers.purgeBiometrics", "2026-09-03T18:00:00.000Z", { wasActive: false });
    await deactivate(s, "2026-09-03T18:00:00.000Z");
    await scan(s, `${DATE}T10:00:00`);
    const [exception] = await inactiveScans(s);
    expect(exception.description).toContain("was deactivated at 2026-09-03 09:00,");
  });

  it.each([
    {
      name: "a legacy Remove followed by a wasActive=false purge",
      rows: [["workers.remove", REMOVED], ["workers.purgeBiometrics", "2026-09-03T18:00:00.000Z", { wasActive: false }]],
      updatedAt: "2026-09-03T18:00:00.000Z",
      text: "was deactivated on or before 2026-09-03 09:00,",
    },
    {
      name: "a legacy repeated Remove",
      rows: [["workers.remove", REMOVED], ["workers.remove", "2026-09-03T16:00:00.000Z"]],
      updatedAt: "2026-09-03T16:00:00.000Z",
      text: "was deactivated on or before 2026-09-03 09:00,",
    },
    {
      name: "a legacy worker with no audit row (updatedAt fallback)",
      rows: [],
      updatedAt: REMOVED,
      text: "was deactivated on or before 2026-09-03 09:00,",
    },
    {
      name: "a purge of an active worker without an enroll row",
      rows: [["workers.purgeBiometrics", REMOVED, { wasActive: true }]],
      updatedAt: REMOVED,
      text: "was deactivated at 2026-09-03 09:00,",
    },
  ] as const)("words the boundary for $name", async ({ rows, updatedAt, text }) => {
    const s = await setup();
    for (const [action, createdAt, details] of rows as unknown as Array<[string, string, Record<string, unknown>?]>) {
      await audit(s, action, createdAt, details);
    }
    await deactivate(s, updatedAt);
    await scan(s, `${DATE}T08:00:00`); // before the boundary: never guessed
    await scan(s, `${DATE}T10:00:00`);
    const flagged = await inactiveScans(s);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].description).toContain(text);
  });

  it("skips an inactive worker with no deactivation evidence at all", async () => {
    const s = await setup();
    await deactivate(s, null);
    await scan(s, `${DATE}T10:00:00`);
    expect(await inactiveScans(s)).toEqual([]);
  });

  it("does not flag a restored worker, even for scans made while inactive", async () => {
    const s = await setup();
    await audit(s, "workers.enroll", ENROLLED);
    await audit(s, "workers.remove", REMOVED);
    await audit(s, "workers.enroll", "2026-09-03T18:00:00.000Z");
    await s.t.run((ctx) => ctx.db.patch(s.workerId, { active: true, updatedAt: "2026-09-03T18:00:00.000Z" }));
    await scan(s, `${DATE}T10:00:00`);
    expect(await inactiveScans(s)).toEqual([]);
  });

  it("skips scans whose worker id is not a current worker document", async () => {
    const s = await setup();
    const deletedId = await s.t.run(async (ctx) => {
      const id = await ctx.db.insert("workers", { name: "Deleted", department: "Framing", enrolledAt: ENROLLED, updatedAt: REMOVED, active: false });
      await ctx.db.delete(id);
      return String(id);
    });
    await scan(s, `${DATE}T10:00:00`, { workerId: deletedId });
    await scan(s, `${DATE}T10:00:00`, { workerId: "legacy-local-42" });
    expect(await inactiveScans(s)).toEqual([]);
  });

  it("excludes voided scans and restores the exception when the void is reversed", async () => {
    const s = await setup();
    await removeAt(s);
    const attendanceId = await scan(s, `${DATE}T10:00:00`);
    const correctionId = await s.t.run((ctx) => ctx.db.insert("attendanceCorrections", {
      date: DATE, workerId: String(s.workerId), action: "void_event",
      originalAttendanceId: attendanceId as Id<"attendance">, reason: "Not this person",
      createdAt: NOW, updatedAt: NOW,
    }));
    expect(await inactiveScans(s)).toEqual([]);

    await s.t.run((ctx) => ctx.db.insert("attendanceCorrectionReversals", {
      correctionId, requestId: "reverse-1", date: DATE, workerId: String(s.workerId),
      reason: "Void was a mistake", actorUserId: s.users.admin, createdAt: NOW,
    }));
    const flagged = await inactiveScans(s);
    expect(flagged.map((exception: any) => exception.attendance_id)).toEqual([attendanceId]);
  });

  it("does not flag supervisor correction rows", async () => {
    const s = await setup();
    await removeAt(s);
    await s.t.run((ctx) => ctx.db.insert("attendanceCorrections", {
      date: DATE, workerId: String(s.workerId), action: "add_clock_in", eventType: "clock_in",
      correctedTimestamp: `${DATE}T10:00:00`, reason: "Manual entry", createdAt: NOW, updatedAt: NOW,
    }));
    const attendance = await s.admin.query(api.attendance.list, { date: DATE });
    expect(attendance.length).toBeGreaterThan(0);
    expect(await inactiveScans(s)).toEqual([]);
  });

  it("flags same-instant duplicate scans separately", async () => {
    const s = await setup();
    await removeAt(s);
    const first = await scan(s, `${DATE}T10:00:00`);
    const second = await scan(s, `${DATE}T10:00:00`, { eventType: "clock_out" });
    const flagged = await inactiveScans(s);
    expect(flagged.map((exception: any) => exception.attendance_id).sort()).toEqual([first, second].sort());
    expect(new Set(flagged.map((exception: any) => exception.key)).size).toBe(2);
    expect(flagged.find((exception: any) => exception.attendance_id === second)?.description).toContain("recorded a clock out at 10:00.");
  });

  it("compares across a midnight boundary", async () => {
    const s = await setup();
    await removeAt(s, "2026-09-03T05:00:00.000Z"); // 00:00 Central
    await scan(s, "2026-09-02T23:59:59");
    const atMidnight = await scan(s, `${DATE}T00:00:00`);
    expect(await inactiveScans(s, "2026-09-02")).toEqual([]);
    const flagged = await inactiveScans(s);
    expect(flagged.map((exception: any) => exception.attendance_id)).toEqual([atMidnight]);
    expect(flagged[0].description).toContain("deactivated at 2026-09-03 00:00, but kiosk Front door recorded a clock in at 00:00.");
  });

  it("orders scans in the repeated DST hour by instant", async () => {
    const s = await setup();
    // 07:15Z is 01:15 CST, the second pass through 01:00-02:00 on 2026-11-01.
    await removeAt(s, "2026-11-01T07:15:00.000Z");
    await scan(s, "2026-11-01T01:30:00-05:00"); // 06:30Z, first pass
    const secondPass = await scan(s, "2026-11-01T01:30:00-06:00"); // 07:30Z
    // Offset-free legacy time: resolved to the earlier occurrence (06:30Z).
    await scan(s, "2026-11-01T01:30:00");
    const flagged = await inactiveScans(s, "2026-11-01");
    expect(flagged.map((exception: any) => exception.attendance_id)).toEqual([secondPass]);
    expect(flagged[0].description).toContain("deactivated at 2026-11-01 01:15,");
  });

  it("does not flag scans or boundaries with invalid timestamps", async () => {
    const s = await setup();
    await removeAt(s);
    await scan(s, `${DATE}T25:00:00`);
    expect(await inactiveScans(s)).toEqual([]);

    const other = await setup();
    await deactivate(other, "not-a-timestamp");
    await scan(other, `${DATE}T10:00:00`);
    expect(await inactiveScans(other)).toEqual([]);
  });
});

describe("inactive worker scan roster context", () => {
  async function rosterSentence(
    seed: (s: Setup) => Promise<void>,
    kioskId = "front-1",
  ) {
    const s = await setup();
    await removeAt(s);
    await seed(s);
    await scan(s, `${DATE}T10:00:00`, { kioskId });
    const [exception] = await inactiveScans(s);
    return exception;
  }

  it("says receipt information is unavailable for a retired kiosk", async () => {
    const exception = await rosterSentence(async (s) => {
      await s.t.run((ctx) => ctx.db.patch(s.kioskDocId, { active: false, rosterAppliedAt: "2026-09-03T15:00:00.000Z" }));
    });
    expect(exception.kiosk_name).toBeNull();
    expect(exception.description).toBe("Alex Removed was deactivated at 2026-09-03 09:00, but kiosk front-1 recorded a clock in at 10:00. Roster receipt information is unavailable for this kiosk.");
  });

  it("says receipt information is unavailable for an unknown kiosk", async () => {
    const exception = await rosterSentence(async () => {}, "ghost-9");
    expect(exception).toMatchObject({ kiosk_id: "ghost-9", kiosk_name: null });
    expect(exception.description).toContain("kiosk ghost-9 recorded a clock in at 10:00. Roster receipt information is unavailable for this kiosk.");
  });

  it("says receipt information is unavailable for an ambiguous kiosk", async () => {
    const exception = await rosterSentence(async (s) => {
      await s.t.run(async (ctx) => {
        for (const location of ["North", "South"]) {
          await ctx.db.insert("kiosks", { name: "Side gate", kioskId: `side-${location}`, type: "entry", location, active: true, rosterAppliedAt: REMOVED });
        }
      });
    }, "Side gate");
    expect(exception.kiosk_name).toBeNull();
    expect(exception.description).toContain("Roster receipt information is unavailable for this kiosk.");
  });

  it("says when the kiosk never acknowledged a roster receipt", async () => {
    const exception = await rosterSentence(async () => {});
    expect(exception.kiosk_name).toBe("Front door");
    expect(exception.description).toContain("This kiosk has not acknowledged any roster receipt.");
  });

  it.each([
    ["2026-09-03T15:00:00.000Z", "This kiosk's latest acknowledged roster receipt was issued at 2026-09-03 10:00."],
    [REMOVED, "This kiosk's latest acknowledged roster receipt was issued at 2026-09-03 09:00."],
    ["2026-09-03T13:59:59.999Z", "This kiosk's latest acknowledged roster receipt was issued before the deactivation."],
  ])("states the receipt at %s factually for an exact boundary", async (rosterAppliedAt, sentence) => {
    const exception = await rosterSentence(async (s) => {
      await s.t.run((ctx) => ctx.db.patch(s.kioskDocId, { rosterAppliedAt }));
    });
    expect(exception.description.endsWith(sentence)).toBe(true);
  });

  it("never claims the receipt predates an approximate deactivation", async () => {
    const s = await setup();
    // Really deactivated at 09:00 before audits existed; the 11:00 Remove is a repeat.
    await audit(s, "workers.remove", "2026-09-03T16:00:00.000Z");
    await deactivate(s, "2026-09-03T16:00:00.000Z");
    await s.t.run((ctx) => ctx.db.patch(s.kioskDocId, { rosterAppliedAt: "2026-09-03T15:00:00.000Z" }));
    await scan(s, `${DATE}T11:30:00`);
    const [exception] = await inactiveScans(s);
    expect(exception.description).toBe("Alex Removed was deactivated on or before 2026-09-03 11:00, but kiosk Front door recorded a clock in at 11:30. This kiosk's latest acknowledged roster receipt was issued at 2026-09-03 10:00.");
    expect(exception.description).not.toContain("before the deactivation");
  });
});

describe("inactive worker scan review", () => {
  it("keeps a reviewed scan reviewed when a later scan arrives, and can reopen it", async () => {
    const s = await setup();
    await removeAt(s);
    const first = await scan(s, `${DATE}T10:00:00`);
    const [a] = await inactiveScans(s);
    await s.admin.mutation(api.shiftExceptions.review, { exceptionKey: a.key, date: DATE, type: a.type, status: "reviewed", note: "Called the kiosk lead" });

    const second = await scan(s, `${DATE}T12:00:00`, { eventType: "clock_out" });
    const flagged = await inactiveScans(s);
    expect(flagged.find((exception: any) => exception.attendance_id === first)).toMatchObject({ key: a.key, status: "reviewed", review_note: "Called the kiosk lead" });
    expect(flagged.find((exception: any) => exception.attendance_id === second)).toMatchObject({ status: "open" });
    expect((await summary(s)).summary.critical).toBe(1);

    await s.admin.mutation(api.shiftExceptions.review, { exceptionKey: a.key, date: DATE, type: a.type, status: "open" });
    const reopened = await inactiveScans(s);
    expect(reopened.find((exception: any) => exception.key === a.key)).toMatchObject({ status: "open", reviewed_at: null });
    expect((await summary(s)).summary.critical).toBe(2);
  });

  it("lets viewers read it, enrollment and admin review it, and refuses anonymous callers", async () => {
    const s = await setup();
    await removeAt(s);
    await scan(s, `${DATE}T10:00:00`);
    const viewerPayload = await s.viewer.query(api.shiftExceptions.summary, { date: DATE });
    const [exception] = viewerPayload.exceptions.filter((row: any) => row.type === "inactive_worker_scan");
    expect(exception).toMatchObject({ status: "open", severity: "critical" });

    const args = { exceptionKey: exception.key, date: DATE, type: exception.type };
    await expect(s.viewer.mutation(api.shiftExceptions.review, { ...args, status: "reviewed" })).rejects.toThrow("Insufficient permissions");
    await expect(s.t.query(api.shiftExceptions.summary, { date: DATE })).rejects.toThrow("Unauthorized");
    await expect(s.t.mutation(api.shiftExceptions.review, { ...args, status: "reviewed" })).rejects.toThrow("Unauthorized");
    expect((await inactiveScans(s))[0].status).toBe("open");

    await s.enrollment.mutation(api.shiftExceptions.review, { ...args, status: "ignored" });
    expect((await inactiveScans(s))[0].status).toBe("ignored");
    await s.admin.mutation(api.shiftExceptions.review, { ...args, status: "resolved", note: "Restored by mistake fixed" });
    expect((await inactiveScans(s))[0]).toMatchObject({ status: "resolved", review_note: "Restored by mistake fixed" });
  });
});

describe("inactive worker scans in shift trust workflows", () => {
  async function onlineKiosk(s: Setup) {
    await s.t.run((ctx) => ctx.db.patch(s.kioskDocId, {
      lastSync: NOW, health: { cameraOk: true, modelOk: true, livenessAvailable: true, reportedAt: NOW },
    }));
  }

  it("blocks an open closeout like any critical exception until it is reviewed", async () => {
    const s = await setup();
    await onlineKiosk(s);
    await removeAt(s);
    await scan(s, `${DATE}T10:00:00`);

    const blocked = await s.enrollment.query(api.shiftCloseouts.get, { date: DATE });
    expect(blocked.summary).toMatchObject({ critical_exceptions: 1, open_exceptions: 1 });
    expect(blocked.checklist.find((item: any) => item.id === "critical_exceptions")).toMatchObject({ status: "blocked", count: 1 });
    expect(blocked.can_complete).toBe(false);
    await expect(s.enrollment.mutation(api.shiftCloseouts.save, { date: DATE, action: "complete" }))
      .rejects.toThrow("acknowledgement note");
    await expect(s.enrollment.mutation(api.shiftCloseouts.save, { date: DATE, action: "complete", acknowledgedBlockers: true }))
      .rejects.toThrow("acknowledgement note");

    const [exception] = await inactiveScans(s);
    await s.enrollment.mutation(api.shiftExceptions.review, { exceptionKey: exception.key, date: DATE, type: exception.type, status: "reviewed" });
    const cleared = await s.enrollment.query(api.shiftCloseouts.get, { date: DATE });
    expect(cleared.summary.critical_exceptions).toBe(0);
    expect(cleared.blockers).toEqual([]);
    await expect(s.enrollment.mutation(api.shiftCloseouts.save, { date: DATE, action: "complete", notes: "Scan reviewed" }))
      .resolves.toMatchObject({ status: "completed" });
  });

  it("shows a late scan in a completed closeout's live summary without changing the signed snapshot", async () => {
    const s = await setup();
    await onlineKiosk(s);
    const closeoutId = await s.t.run((ctx) => ctx.db.insert("shiftCloseouts", {
      date: DATE, status: "completed", notes: "Signed", supervisorName: "Signed supervisor",
      acknowledgedBlockers: false, expected: 0, present: 0, late: 0, missing: 0,
      openExceptions: 0, criticalExceptions: 0, kioskWarnings: 0,
      completedAt: "2026-09-03T23:00:00.000Z", createdAt: "2026-09-03T22:00:00.000Z", updatedAt: "2026-09-03T23:00:00.000Z",
    }));
    const before = await s.t.run((ctx) => ctx.db.get(closeoutId));
    await removeAt(s);
    await scan(s, `${DATE}T10:00:00`);

    const payload = await s.enrollment.query(api.shiftCloseouts.get, { date: DATE });
    expect(payload.closeout).toMatchObject({ status: "completed", snapshot: { critical_exceptions: 0, open_exceptions: 0 } });
    expect(payload.summary.critical_exceptions).toBe(1);
    expect(payload.checklist.find((item: any) => item.id === "critical_exceptions")).toMatchObject({ status: "blocked", count: 1 });
    expect(await s.t.run((ctx) => ctx.db.get(closeoutId))).toEqual(before);
  });

  it("counts in briefing critical totals and is eligible for the capped action list", async () => {
    const s = await setup();
    await onlineKiosk(s);
    await removeAt(s);
    for (let minute = 0; minute < 10; minute += 1) {
      await scan(s, `${DATE}T10:${String(minute).padStart(2, "0")}:00`, { eventType: minute % 2 ? "clock_out" : "clock_in" });
    }

    const briefing = await s.viewer.query(api.shiftBriefing.summary, { date: DATE });
    expect(briefing.summary.open_exceptions).toBe(10);
    expect(briefing.shift_trust_brief.source_counts.critical_exceptions).toBe(10);
    expect(briefing.shift_trust_brief.readiness_blockers).toContainEqual(expect.objectContaining({ id: "exception:critical", severity: "critical" }));
    const actions = briefing.action_items.filter((item: any) => item.id.startsWith(`${DATE}:inactive_worker_scan:`));
    expect(actions).toHaveLength(8);
    expect(actions.every((item: any) => item.priority === "critical" && item.href.includes("type=inactive_worker_scan"))).toBe(true);
    expect(actions[0].href).not.toContain("intent=");
  });
});
