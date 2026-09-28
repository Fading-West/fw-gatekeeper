/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import schema from "./schema";
import { listRecognitionAttemptsByFactoryDate } from "./recognitionAttempts";
import { createRecognitionTimestampSortKey } from "./recognitionTimestamp";
const modules = import.meta.glob("./**/*.ts");

it("sorts mixed UTC, offset, and factory-local evidence before limiting", async () => {
  const t = convexTest(schema, modules);
  const timestamps = [
    "2026-09-15T13:00:00Z",
    "2026-09-15T09:00:00",
    "2026-09-15T16:30:00+02:00",
    "2026-09-15T09:30:00.123455",
    "2026-09-15T14:30:00.123456Z",
    "2026-09-15 09:30:00.123457-0500",
  ];
  await t.run(async ctx => {
    for (const timestamp of timestamps) await ctx.db.insert("recognitionAttempts", {
      timestamp, kioskId: "entry", faceDetected: true, decision: "matched",
      threshold: 0.3, reviewed: false, createdAt: "2026-09-15T20:00:00Z",
    });
  });
  const rows = await t.run(ctx => listRecognitionAttemptsByFactoryDate(ctx, { date: "2026-09-15" }));
  expect(rows.map(row => row.timestamp)).toEqual([...timestamps].reverse());
  const limited = await t.run(ctx => listRecognitionAttemptsByFactoryDate(ctx, { date: "2026-09-15", limit: 1 }));
  expect(limited[0].timestamp).toBe(timestamps.at(-1));
});

it("retains true instant order during fall-back and chooses the earlier legacy occurrence", () => {
  const key = createRecognitionTimestampSortKey();
  expect(key("2026-11-01T01:15:00-06:00") > key("2026-11-01T01:45:00-05:00")).toBe(true);
  expect(key("2026-11-01T01:30:00")).toBe(key("2026-11-01T06:30:00Z"));
  expect(key("2026-03-08T02:30:00")).toBe("");
});

it("normalizes equal fractional instants and handles winter offsets", () => {
  const key = createRecognitionTimestampSortKey();
  expect(key("2026-01-15T09:00:00.100000")).toBe(key("2026-01-15T15:00:00.1Z"));
  expect(key("2026-01-15T09:00:00.000001") > key("2026-01-15T15:00:00Z")).toBe(true);
  expect(key("2026-01-15T25:00:00")).toBe("");
});

it("orders equal instants deterministically by ID across timestamp representations", async () => {
  const t = convexTest(schema, modules);
  const ids = await t.run(async ctx => {
    const ids = [];
    for (const timestamp of ["2026-09-15T09:00:00", "2026-09-15T14:00:00.000Z"]) ids.push(await ctx.db.insert("recognitionAttempts", {
      timestamp, kioskId: "entry", faceDetected: true, decision: "matched",
      threshold: 0.3, reviewed: false, createdAt: "2026-09-15T20:00:00Z",
    }));
    return ids;
  });
  const rows = await t.run(ctx => listRecognitionAttemptsByFactoryDate(ctx, { date: "2026-09-15" }));
  expect(rows.map(row => row.id)).toEqual(ids.sort((a, b) => a.localeCompare(b)));
});
