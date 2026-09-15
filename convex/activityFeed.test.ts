/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const TOKEN = "activity-test-token-that-is-long-enough-12345";
const NOW = new Date("2026-09-14T18:00:00.000Z");

type SetupOptions = { active?: boolean; role?: "admin" | "enrollment" | "viewer" };

async function setup(options: SetupOptions = {}) {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const sourceAccountId = await ctx.db.insert("users", { email: "source-admin@example.test", name: "Source Admin" });
    const actorId = await ctx.db.insert("users", { email: "operator@example.test", name: "Avery Operator" });
    const emailActorId = await ctx.db.insert("users", { email: "recorded@example.test" });
    await ctx.db.insert("portalMembers", {
      userId: sourceAccountId,
      role: options.role ?? "admin",
      active: options.active ?? true,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const workerId = await ctx.db.insert("workers", {
      name: "Sample Worker",
      employeeId: "PRIVATE-77",
      department: "Private Department",
      faceEncoding: [0.123],
      enrolledAt: "2026-01-01T00:00:00.000Z",
      active: false,
    });
    return { sourceAccountId, actorId, emailActorId, workerId };
  });
  vi.stubEnv("ACTIVITY_FW_GATEWAY_TOKEN", TOKEN);
  vi.stubEnv("ACTIVITY_FW_GATEWAY_ACCOUNT_ID", ids.sourceAccountId);
  return { t, ...ids };
}

async function insertAudit(t: ReturnType<typeof convexTest>, entry: {
  actorUserId: Id<"users">;
  action: string;
  targetTable?: string;
  targetId: string;
  createdAt: string;
  reason?: string;
  details?: string;
}) {
  return await t.run((ctx) => ctx.db.insert("auditLog", {
    targetTable: "workers",
    ...entry,
  }));
}

function request(t: ReturnType<typeof convexTest>, token = TOKEN) {
  return t.fetch("/api/internal/activity", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
}

beforeEach(() => vi.setSystemTime(NOW));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("Gateway activity HTTP endpoint", () => {
  it("rejects absent and invalid credentials and stays disabled without complete configuration", async () => {
    const { t } = await setup();
    expect((await t.fetch("/api/internal/activity", { method: "GET" })).status).toBe(401);
    expect((await request(t, "not-the-right-activity-token-1234567890")).status).toBe(401);

    vi.stubEnv("ACTIVITY_FW_GATEWAY_TOKEN", "");
    expect((await request(t)).status).toBe(503);
    vi.stubEnv("ACTIVITY_FW_GATEWAY_TOKEN", TOKEN);
    vi.stubEnv("ACTIVITY_FW_GATEWAY_ACCOUNT_ID", "");
    expect((await request(t)).status).toBe(503);
  });

  it.each([
    { active: false, role: "admin" as const },
    { active: true, role: "enrollment" as const },
    { active: true, role: "viewer" as const },
  ])("re-evaluates active admin permission on every request: %o", async (options) => {
    const { t } = await setup(options);
    expect((await request(t)).status).toBe(403);
  });

  it("revokes a previously valid credential immediately when the mapped account is disabled or demoted", async () => {
    const { t, sourceAccountId } = await setup();
    expect((await request(t)).status).toBe(200);
    await t.run(async (ctx) => {
      const member = await ctx.db.query("portalMembers").withIndex("by_user", (q) => q.eq("userId", sourceAccountId)).unique();
      await ctx.db.patch(member!._id, { active: false });
    });
    expect((await request(t)).status).toBe(403);
    await t.run(async (ctx) => {
      const member = await ctx.db.query("portalMembers").withIndex("by_user", (q) => q.eq("userId", sourceAccountId)).unique();
      await ctx.db.patch(member!._id, { active: true, role: "viewer" });
    });
    expect((await request(t)).status).toBe(403);
  });

  it("returns only allowlisted operational events with immutable IDs, source attribution, labels, and timestamps", async () => {
    const { t, actorId, emailActorId, workerId } = await setup();
    const olderId = await insertAudit(t, {
      actorUserId: emailActorId,
      action: "workers.updateIdentity",
      targetId: workerId,
      createdAt: "2026-09-14T16:00:00.000Z",
      reason: "SECRET REASON",
      details: "SECRET DETAILS PRIVATE-77 Private Department",
    });
    const newerId = await insertAudit(t, {
      actorUserId: actorId,
      action: "workers.remove",
      targetId: workerId,
      createdAt: "2026-09-14T17:00:00.000Z",
    });
    await insertAudit(t, { actorUserId: actorId, action: "workers.enroll", targetId: workerId, createdAt: "2026-09-14T17:30:00.000Z", details: "FACE TEMPLATE" });
    await insertAudit(t, { actorUserId: actorId, action: "workers.purgeBiometrics", targetId: workerId, createdAt: "2026-09-14T17:20:00.000Z", reason: "PRIVATE PURGE" });
    await insertAudit(t, { actorUserId: actorId, action: "workers.remove", targetTable: "attendance", targetId: workerId, createdAt: "2026-09-14T17:10:00.000Z" });

    const response = await request(t);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const payload = await response.json();
    expect(payload).toEqual({
      version: 1,
      asOf: NOW.toISOString(),
      hasMore: false,
      items: [
        { id: newerId, occurredAt: "2026-09-14T17:00:00.000Z", actor: "Avery Operator", action: "deactivated worker", subject: "Sample Worker", outcome: "succeeded", url: "/workers" },
        { id: olderId, occurredAt: "2026-09-14T16:00:00.000Z", actor: "recorded@example.test", action: "updated worker record", subject: "Sample Worker", outcome: "succeeded", url: "/workers" },
      ],
    });
    const serialized = JSON.stringify(payload);
    for (const forbidden of ["reason", "details", "SECRET", "PRIVATE-77", "Private Department", "FACE TEMPLATE", "purgeBiometrics", "faceEncoding"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("preserves actor and subject text at the exact contract boundaries", async () => {
    const { t, actorId, workerId } = await setup();
    const actorName = "a".repeat(160);
    const subjectName = "s".repeat(240);
    await t.run(async (ctx) => {
      await ctx.db.patch(actorId, { name: actorName });
      await ctx.db.patch(workerId, { name: subjectName });
    });
    const id = await insertAudit(t, { actorUserId: actorId, action: "workers.remove", targetId: workerId, createdAt: "2026-09-14T17:00:00.000Z" });

    expect((await (await request(t)).json()).items[0]).toEqual(expect.objectContaining({
      id,
      actor: actorName,
      subject: subjectName,
      action: "deactivated worker",
    }));
  });

  it("caps oversized actor and subject names without changing the event ID or timestamp", async () => {
    const { t, actorId, workerId } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.patch(actorId, { name: "a".repeat(161) });
      await ctx.db.patch(workerId, { name: "s".repeat(241) });
    });
    const occurredAt = "2026-09-14T17:00:00.000Z";
    const id = await insertAudit(t, { actorUserId: actorId, action: "workers.updateIdentity", targetId: workerId, createdAt: occurredAt });
    const item = (await (await request(t)).json()).items[0];

    expect(item).toEqual(expect.objectContaining({ id, occurredAt }));
    expect(Array.from(item.actor)).toHaveLength(160);
    expect(Array.from(item.subject)).toHaveLength(240);
    expect(Array.from(item.action).length).toBeLessThanOrEqual(160);
  });

  it("orders newest first, caps at 100, reports truncation, and omits unsafe timestamps and out-of-window rows", async () => {
    const { t, actorId, workerId } = await setup();
    const ids: string[] = [];
    for (let index = 0; index < 101; index += 1) {
      ids.push(await insertAudit(t, {
        actorUserId: actorId,
        action: "workers.updateIdentity",
        targetId: workerId,
        createdAt: new Date(NOW.getTime() - index * 60_000).toISOString(),
      }));
    }
    await insertAudit(t, { actorUserId: actorId, action: "workers.remove", targetId: workerId, createdAt: "not-a-timestamp" });
    await insertAudit(t, { actorUserId: actorId, action: "workers.remove", targetId: workerId, createdAt: "2026-07-01T00:00:00.000Z" });

    const payload = await (await request(t)).json();
    expect(payload.items).toHaveLength(100);
    expect(payload.hasMore).toBe(true);
    expect(payload.items[0].id).toBe(ids[0]);
    expect(payload.items[99].id).toBe(ids[99]);
  });

  it("uses an explicit unattributed label and a generic subject when referenced records no longer exist", async () => {
    const { t, actorId, workerId } = await setup();
    const id = await insertAudit(t, { actorUserId: actorId, action: "workers.remove", targetId: workerId, createdAt: "2026-09-14T17:00:00.000Z" });
    await t.run(async (ctx) => {
      await ctx.db.delete(actorId);
      await ctx.db.delete(workerId);
    });
    expect((await (await request(t)).json()).items[0]).toEqual(expect.objectContaining({ id, actor: "Actor not recorded", subject: "Worker record" }));
  });

  it("finds eligible events after many newer excluded audit actions and computes hasMore from eligible rows", async () => {
    const { t, actorId, workerId } = await setup();
    await t.run(async (ctx) => {
      for (let index = 0; index < 750; index += 1) {
        await ctx.db.insert("auditLog", {
          actorUserId: actorId,
          action: index % 2 === 0 ? "workers.enroll" : "workers.purgeBiometrics",
          targetTable: "workers",
          targetId: workerId,
          createdAt: "2026-09-14T17:30:00.000Z",
        });
      }
    });
    const newerId = await insertAudit(t, { actorUserId: actorId, action: "workers.remove", targetId: workerId, createdAt: "2026-09-14T17:00:00.000Z" });
    const olderId = await insertAudit(t, { actorUserId: actorId, action: "workers.updateIdentity", targetId: workerId, createdAt: "2026-09-14T16:00:00.000Z" });

    const payload = await (await request(t)).json();
    expect(payload.items.map((item: { id: string }) => item.id)).toEqual([newerId, olderId]);
    expect(payload.hasMore).toBe(false);
  });

  it("fails closed when the bounded allowlisted scan cannot determine eligible pagination", async () => {
    const { t, actorId, workerId } = await setup();
    await t.run(async (ctx) => {
      for (let index = 0; index < 501; index += 1) {
        await ctx.db.insert("auditLog", {
          actorUserId: actorId,
          action: "workers.remove",
          targetTable: "workers",
          targetId: workerId,
          createdAt: "2026-09-14T17:59:59.000Z-invalid",
        });
      }
    });
    await insertAudit(t, { actorUserId: actorId, action: "workers.remove", targetId: workerId, createdAt: "2026-09-14T17:00:00.000Z" });

    const response = await request(t);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Activity feed unavailable" });
  });

  it("never returns a successful body larger than the literal 256,000-byte contract limit", async () => {
    const { t, actorId, workerId } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.patch(actorId, { name: "\u0000".repeat(160) });
      await ctx.db.patch(workerId, { name: "\u0000".repeat(240) });
    });
    for (let index = 0; index < 101; index += 1) {
      await insertAudit(t, {
        actorUserId: actorId,
        action: "workers.remove",
        targetId: workerId,
        createdAt: new Date(NOW.getTime() - index * 60_000).toISOString(),
      });
    }
    const response = await request(t);
    const body = await response.text();
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(256_000);
    expect(JSON.parse(body)).toMatchObject({ hasMore: true });
  });
});
