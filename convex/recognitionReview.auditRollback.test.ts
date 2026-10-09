/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, expect, it, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

const audit = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock("./audit", () => ({ writeAuditLog: audit.write }));
const modules = import.meta.glob("./**/*.ts");

beforeEach(() => {
  audit.write.mockReset();
  audit.write.mockRejectedValue(new Error("Audit persistence unavailable"));
});

it.each([false, true])("rolls back a Recognition Lab review when its audit fails (reviewed=%s)", async reviewed => {
  const t = convexTest(schema, modules);
  const { userId, attemptId } = await t.run(async ctx => {
    const userId = await ctx.db.insert("users", { email: "audit-rollback@example.test" });
    await ctx.db.insert("portalMembers", { userId, role: "enrollment", active: true, createdAt: "2026-10-01" });
    const attemptId = await ctx.db.insert("recognitionAttempts", {
      kioskId: "synthetic", timestamp: "2026-10-01T08:00:00", faceDetected: true,
      decision: "near_miss", threshold: 0.45, reviewed, reviewedLabel: "confirmed",
      reviewedNote: "Original note", reviewedAt: reviewed ? "2026-10-01T09:00:00Z" : undefined,
      createdAt: "2026-10-01T08:00:00Z", updatedAt: "2026-10-01T09:00:00Z",
    });
    return { userId, attemptId };
  });
  const before = await t.run(ctx => ctx.db.get(attemptId));
  await expect(t.withIdentity({ subject: userId }).mutation(api.recognitionAttempts.updateReview, {
    id: attemptId, reviewed: !reviewed, reviewedLabel: "ignored", reviewedNote: "New note",
  })).rejects.toThrow("Audit persistence unavailable");
  expect(audit.write).toHaveBeenCalledOnce();
  expect(audit.write).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    actorUserId: userId, action: "recognition.review", targetId: attemptId,
  }));
  expect(await t.run(ctx => ctx.db.get(attemptId))).toEqual(before);
  expect(await t.run(ctx => ctx.db.query("auditLog").collect())).toEqual([]);
});
