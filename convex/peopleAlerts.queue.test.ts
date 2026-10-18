/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const now = new Date("2026-10-18T16:00:00.000Z");
const event = (label: string) => ({
  kind: "worker" as const, targetId: label, label, createdAt: now.toISOString(), delivered: false,
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function configureWebhook() {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubEnv("RESEND_API_KEY", "");
  vi.stubEnv("PEOPLE_ALERT_WEBHOOK_URL", "https://example.test/people");
}

describe("people alert queue progress", () => {
  it("delivers later events while retaining and deferring a failed event for retry", async () => {
    configureWebhook();
    const t = convexTest(schema, modules);
    const [failedId, healthyId] = await t.run(async (ctx) => [
      await ctx.db.insert("peopleAlertEvents", event("Rejected worker")),
      await ctx.db.insert("peopleAlertEvents", { ...event("New account"), kind: "portal_account" }),
    ]);
    const send = vi.fn(async (_url: string, request: RequestInit) => {
      const { event_id } = JSON.parse(String(request.body));
      return new Response("{}", { status: event_id === failedId ? 422 : 200 });
    });
    vi.stubGlobal("fetch", send);

    expect(await t.action(internal.peopleAlerts.deliverPending, {})).toEqual({ delivered: 1, configured: true });
    expect(send).toHaveBeenCalledTimes(2);
    expect(await t.run((ctx) => ctx.db.get(healthyId))).toMatchObject({ delivered: true });
    expect(await t.run((ctx) => ctx.db.get(failedId))).toMatchObject({
      delivered: false, claimedUntil: now.getTime() + 60_000,
    });

    // Another run must not hammer the same rejected event or repeat success.
    expect(await t.action(internal.peopleAlerts.deliverPending, {})).toEqual({ delivered: 0, configured: true });
    expect(send).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60_000);
    send.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    expect(await t.action(internal.peopleAlerts.deliverPending, {})).toEqual({ delivered: 1, configured: true });
    expect(await t.run((ctx) => ctx.db.get(failedId))).toMatchObject({ delivered: true });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("finds an eligible event beyond 100 leased or deferred rows", async () => {
    configureWebhook();
    const t = convexTest(schema, modules);
    const eligibleId = await t.run(async (ctx) => {
      for (let index = 0; index < 100; index++) {
        await ctx.db.insert("peopleAlertEvents", {
          ...event(`Deferred ${index}`), claimedUntil: now.getTime() + 60_000,
        });
      }
      return ctx.db.insert("peopleAlertEvents", event("Ready worker"));
    });

    expect(await t.mutation(internal.peopleAlerts.claimPending, {})).toMatchObject({ id: eligibleId });
    expect(await t.mutation(internal.peopleAlerts.claimPending, {})).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(await t.mutation(internal.peopleAlerts.claimPending, {})).not.toBeNull();
  });

  it("bounds a provider outage to 20 attempts of distinct events per run", async () => {
    configureWebhook();
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let index = 0; index < 21; index++) {
        await ctx.db.insert("peopleAlertEvents", event(`Worker ${index}`));
      }
    });
    const send = vi.fn(async (_url: string, _request: RequestInit) => new Response("{}", { status: 503 }));
    vi.stubGlobal("fetch", send);

    expect(await t.action(internal.peopleAlerts.deliverPending, {})).toEqual({ delivered: 0, configured: true });
    expect(send).toHaveBeenCalledTimes(20);
    expect(new Set(send.mock.calls.map(([, request]) => JSON.parse(String(request.body)).event_id)).size).toBe(20);
    const rows = await t.run((ctx) => ctx.db.query("peopleAlertEvents").collect());
    expect(rows.every((row) => !row.delivered)).toBe(true);
    expect(rows.filter((row) => row.claimedUntil === now.getTime() + 60_000)).toHaveLength(20);
  });
});
