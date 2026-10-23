/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, it, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");
afterEach(() => vi.useRealTimers());

it("records review ordering and effective retained or cleared metadata", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const now = "2026-10-01T15:00:00.000Z";
  vi.setSystemTime(new Date(now));
  const t = convexTest(schema, modules);
  const { userId, attemptId } = await t.run(async ctx => {
    const userId = await ctx.db.insert("users", { email: "audit-details@example.test" });
    await ctx.db.insert("portalMembers", { userId, role: "enrollment", active: true, createdAt: now });
    const attemptId = await ctx.db.insert("recognitionAttempts", {
      kioskId: "synthetic", timestamp: "2026-10-01T08:00:00", faceDetected: true,
      decision: "near_miss", threshold: 0.45, reviewed: true, reviewedLabel: "confirmed",
      reviewedNote: "Original note", reviewedAt: "2026-10-01T09:00:00Z", createdAt: now,
      updatedAt: "2026-10-01T10:00:00Z",
    });
    return { userId, attemptId };
  });
  const actor = t.withIdentity({ subject: userId });
  await actor.mutation(api.recognitionAttempts.updateReview, { id: attemptId, reviewedNote: "   " });
  const audits = await t.run(ctx => ctx.db.query("auditLog").collect());
  expect(JSON.parse(audits[0].details!)).toEqual({
    before: { updatedAt: "2026-10-01T10:00:00Z", reviewedAt: "2026-10-01T09:00:00Z", reviewed: true, label: "confirmed", note: "Original note" },
    after: { updatedAt: now, reviewedAt: "2026-10-01T09:00:00Z", reviewed: true, label: "confirmed", note: null },
  });
});

it("records old exception attribution before replacing it with the submitted date/type", async () => {
  const t = convexTest(schema, modules);
  const userId = await t.run(async ctx => {
    const userId = await ctx.db.insert("users", { email: "exception-attribution@example.test" });
    await ctx.db.insert("portalMembers", { userId, role: "admin", active: true, createdAt: "2026-10-01" });
    await ctx.db.insert("exceptionReviews", {
      exceptionKey: "2026-10-01:recognition_review:synthetic", date: "2026-09-30", type: "legacy",
      status: "open", updatedAt: "2026-10-01T09:00:00Z",
    });
    return userId;
  });
  await t.withIdentity({ subject: userId }).mutation(api.shiftExceptions.review, {
    exceptionKey: "2026-10-01:recognition_review:synthetic", date: "2026-10-01", type: "recognition_review", status: "reviewed",
  });
  const audits = await t.run(ctx => ctx.db.query("auditLog").collect());
  expect(JSON.parse(audits[0].details!)).toMatchObject({
    before: { date: "2026-09-30", type: "legacy" }, after: { date: "2026-10-01", type: "recognition_review" },
  });
});
