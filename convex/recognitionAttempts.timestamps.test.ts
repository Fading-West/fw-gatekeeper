/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { getRecognitionDisplayTimestamp } from "./recognitionTimestamp";

const modules = import.meta.glob("./**/*.ts");

it.each([
  ["2026-10-09", ["2026-10-09T12:05:00+00:00"], ["2026-10-09T07:05:00"]],
  ["2026-03-08", ["2026-03-08T07:59:00Z", "2026-03-08T08:01:00Z"], ["2026-03-08T01:59:00", "2026-03-08T03:01:00"]],
  ["2026-11-01", ["2026-11-01T06:45:00Z", "2026-11-01T07:15:00Z"], ["2026-11-01T01:45:00", "2026-11-01T01:15:00"]],
  ["2026-11-01", ["2026-11-02T05:05:00.123456Z"], ["2026-11-01T23:05:00.123456"]],
] as Array<[string, string[], string[]]>)("uses attendance display formatting on %s without changing evidence order", async (date, timestamps, localTimes) => {
  const t = convexTest(schema, modules);
  const { userId, ids } = await t.run(async ctx => {
    const userId = await ctx.db.insert("users", { email: "viewer@example.test" });
    await ctx.db.insert("portalMembers", { userId, role: "viewer", active: true, createdAt: date });
    const ids = [];
    for (const timestamp of timestamps) {
      ids.push(await ctx.db.insert("recognitionAttempts", {
        timestamp, kioskId: "entry", faceDetected: true, decision: "near_miss",
        threshold: 0.3, reviewed: false, createdAt: date,
      }));
      await ctx.db.insert("attendance", { workerId: "legacy-worker", eventType: "clock_in", timestamp, synced: true });
    }
    return { userId, ids };
  });
  const viewer = t.withIdentity({ subject: userId });
  const attempts = await viewer.query(api.recognitionAttempts.listByDate, { date });
  expect(attempts.map(row => row.id)).toEqual([...ids].reverse());
  expect(attempts.map(row => row.timestamp)).toEqual([...localTimes].reverse());
  const attendance = await viewer.query(api.attendance.list, { date });
  expect(attempts.map(row => row.timestamp)).toEqual(attendance.map(row => row.timestamp));
  expect(attempts.map(row => row.timestamp_utc)).toEqual(attendance.map(row => row.timestamp_utc));
  expect((await viewer.query(api.recognitionAttempts.listByDate, { date, limit: 1 }))[0].id).toBe(ids.at(-1));
  for (const [index, id] of ids.entries()) {
    expect(await viewer.query(api.recognitionAttempts.getById, { id, date })).toMatchObject({ timestamp: localTimes[index] });
    expect(await t.run(ctx => ctx.db.get(id))).toMatchObject({ timestamp: timestamps[index] });
  }
  const exceptions = (await viewer.query(api.shiftExceptions.summary, { date })).exceptions.filter(row => row.type === "recognition_review");
  expect(exceptions.map(row => row.key)).toEqual(ids.map(id => `${date}:recognition_review:${id}`));
  expect(exceptions.map(row => row.first_seen)).toEqual(localTimes);
  expect(exceptions.map(row => row.last_seen)).toEqual(localTimes);
  expect(exceptions.map(row => row.last_seen_utc)).toEqual([...attempts].reverse().map(row => row.timestamp_utc));
});

it("respects the configured factory zone and retains fractional attendance precision", () => {
  expect(getRecognitionDisplayTimestamp("2026-10-09T12:05:00.123456Z", { timeZone: "America/Los_Angeles" }))
    .toBe("2026-10-09T05:05:00.123456");
  expect(getRecognitionDisplayTimestamp("2026-10-09T07:05:00.123456"))
    .toBe("2026-10-09T07:05:00.123456");
});
