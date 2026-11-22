/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { buildPeopleAlert, readPeopleAlertConfig } from "./peopleAlerts";

const modules = import.meta.glob("./**/*.ts");
const encoding = Array.from({ length: 512 }, () => 0.1);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("new person alerts", () => {
  it("records a new worker once, but not identity updates", async () => {
    // Keep this test's scheduled delivery from using the next test's providers.
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const adminId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", { email: "admin@example.test" });
      await ctx.db.insert("portalMembers", { userId: id, role: "admin", active: true, createdAt: new Date().toISOString() });
      return id;
    });
    const admin = t.withIdentity({ subject: adminId });
    const added = await admin.mutation(api.workers.create, {
      name: "New Worker", department: "Assembly", faceEncoding: encoding,
      consentAt: new Date().toISOString(),
    });
    await admin.mutation(api.workers.update, { id: added.id, expectedIdentityRevision: (await admin.query(api.workers.get, { id: added.id }))?.identity_revision, department: "Production" });
    const events = await t.run((ctx) => ctx.db.query("peopleAlertEvents").collect());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "worker", targetId: added.id, label: "New Worker", delivered: false });
  });

  it("sends one email, marks delivery, and does not repeat it", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) => ctx.db.insert("peopleAlertEvents", {
      kind: "worker", targetId: "worker-1", label: "New Worker", detail: "Assembly",
      createdAt: "2026-09-28T16:00:00.000Z", delivered: false,
    }));
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("ALERT_EMAIL_FROM", "alerts@example.test");
    vi.stubEnv("PEOPLE_ALERT_EMAIL_TO", "owner@example.test");
    const send = vi.fn(async (_url: string, _request: RequestInit) =>
      new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));
    vi.stubGlobal("fetch", send);
    expect(await t.action(internal.peopleAlerts.deliverPending, {})).toEqual({ delivered: 1, configured: true });
    expect(await t.action(internal.peopleAlerts.deliverPending, {})).toEqual({ delivered: 0, configured: true });
    expect(send).toHaveBeenCalledTimes(1);
    const [, request] = send.mock.calls[0];
    expect(new Headers(request.headers).get("Idempotency-Key")).toContain("fw-gatekeeper-person-");
    expect(JSON.parse(String(request.body)).to).toEqual(["owner@example.test"]);
    const [event] = await t.run((ctx) => ctx.db.query("peopleAlertEvents").collect());
    expect(event.delivered).toBe(true);
  });

  it("retains pending alerts when delivery is not configured", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) => ctx.db.insert("peopleAlertEvents", {
      kind: "worker", targetId: "worker-1", label: "New Worker",
      createdAt: "2026-09-28T16:00:00.000Z", delivered: false,
    }));
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("ALERT_EMAIL_FROM", "");
    vi.stubEnv("PEOPLE_ALERT_EMAIL_TO", "");
    vi.stubEnv("ALERT_EMAIL_TO", "");
    vi.stubEnv("PEOPLE_ALERT_WEBHOOK_URL", "");
    expect(await t.action(internal.peopleAlerts.deliverPending, {})).toEqual({ delivered: 0, configured: false });
    const [event] = await t.run((ctx) => ctx.db.query("peopleAlertEvents").collect());
    expect(event.delivered).toBe(false);
  });

  it("retries a provider failure without losing the alert", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-18T16:00:00.000Z"));
    const t = convexTest(schema, modules);
    await t.run((ctx) => ctx.db.insert("peopleAlertEvents", {
      kind: "portal_account", targetId: "member-1", label: "new@example.test",
      createdAt: "2026-09-28T16:00:00.000Z", delivered: false,
    }));
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("ALERT_EMAIL_FROM", "alerts@example.test");
    vi.stubEnv("PEOPLE_ALERT_EMAIL_TO", "owner@example.test");
    const send = vi.fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));
    vi.stubGlobal("fetch", send);
    expect(await t.action(internal.peopleAlerts.deliverPending, {})).toEqual({ delivered: 0, configured: true });
    expect(await t.action(internal.peopleAlerts.deliverPending, {})).toEqual({ delivered: 0, configured: true });
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(await t.action(internal.peopleAlerts.deliverPending, {})).toEqual({ delivered: 1, configured: true });
    const [event] = await t.run((ctx) => ctx.db.query("peopleAlertEvents").collect());
    expect(event.delivered).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

it("keeps a failed email pending even if its optional webhook was accepted", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-22T16:00:00.000Z"));
  const t = convexTest(schema, modules);
  const id = await t.run((ctx) => ctx.db.insert("peopleAlertEvents", {
    kind: "worker", targetId: "synthetic-worker", label: "Synthetic Worker",
    createdAt: new Date().toISOString(), delivered: false,
  }));
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("ALERT_EMAIL_FROM", "alerts@example.test");
  vi.stubEnv("PEOPLE_ALERT_EMAIL_TO", "owner@example.test");
  const webhook = "https://webhook.example.test/alerts";
  vi.stubEnv("PEOPLE_ALERT_WEBHOOK_URL", webhook);
  const email = vi.fn<(request: RequestInit) => Promise<Response>>()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(new Response(null, { status: 200 }));
  const send = vi.fn((url: string, request: RequestInit) =>
    url === webhook ? Promise.resolve(new Response(null, { status: 200 })) : email(request));
  vi.stubGlobal("fetch", send);

  await expect(t.action(internal.peopleAlerts.deliverPending, {})).resolves.toMatchObject({ delivered: 0 });
  expect(send.mock.calls.map(([url]) => url)).toEqual(["https://api.resend.com/emails", webhook]);
  expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ delivered: false });
  await expect(t.action(internal.peopleAlerts.deliverPending, {})).resolves.toMatchObject({ delivered: 0 });
  expect(email).toHaveBeenCalledTimes(1);

  vi.advanceTimersByTime(60_000);
  await expect(t.action(internal.peopleAlerts.deliverPending, {})).resolves.toMatchObject({ delivered: 1 });
  expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ delivered: true });
  expect(email).toHaveBeenCalledTimes(2);
  expect(email.mock.calls.map(([request]) => new Headers(request.headers).get("Idempotency-Key")))
    .toEqual([`fw-gatekeeper-person-${id}`, `fw-gatekeeper-person-${id}`]);
});
