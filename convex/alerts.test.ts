/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { internal } from "./_generated/api";
import {
  DEFAULT_THRESHOLDS,
  OFFLINE_THRESHOLD_MS,
  RENOTIFY_INTERVAL_MS,
  STALE_THRESHOLD_MS,
  buildAlertMessage,
  evaluateKioskAlerts,
  planKioskNotifications,
  readAlertConfig,
  type AlertKiosk,
} from "./alerts";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const NOW = Date.parse("2026-09-05T03:00:00.000Z");
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function kiosk(overrides: Partial<AlertKiosk> = {}): AlertKiosk {
  return {
    kioskId: "kiosk-doc-1",
    name: "Main Entry",
    location: "Building A",
    deviceId: "kiosk-1",
    lastSync: new Date(NOW - 2 * MINUTE).toISOString(),
    health: { cameraOk: true, modelOk: true, queuedLogs: 0, reportedAt: new Date(NOW - 2 * MINUTE).toISOString() },
    ...overrides,
  };
}

function conditionsFor(k: AlertKiosk, nowMs = NOW) {
  return evaluateKioskAlerts([k], nowMs).map((row) => row.conditions)[0];
}

describe("evaluateKioskAlerts", () => {
  it("produces nothing for a healthy kiosk", () => {
    expect(conditionsFor(kiosk())).toEqual([]);
  });

  it("flags stale between 15 and 60 minutes, and not offline", () => {
    const stale = kiosk({ lastSync: new Date(NOW - 30 * MINUTE).toISOString() });
    expect(conditionsFor(stale)).toEqual(["stale"]);

    const justUnder = kiosk({ lastSync: new Date(NOW - STALE_THRESHOLD_MS).toISOString() });
    expect(conditionsFor(justUnder)).toEqual([]);
  });

  it("flags offline beyond 60 minutes and suppresses stale for the same kiosk", () => {
    const offline = kiosk({ lastSync: new Date(NOW - 2 * HOUR).toISOString() });
    const conditions = conditionsFor(offline);
    expect(conditions).toContain("offline");
    expect(conditions).not.toContain("stale");

    const boundary = kiosk({ lastSync: new Date(NOW - OFFLINE_THRESHOLD_MS).toISOString() });
    expect(conditionsFor(boundary)).toEqual(["stale"]);
  });

  it("does not report malformed or future sync times as healthy", () => {
    expect(conditionsFor(kiosk({ lastSync: "not-a-date" }))).toContain("stale");
    expect(conditionsFor(kiosk({ lastSync: new Date(NOW + HOUR).toISOString() }))).toContain("stale");
  });

  it("flags never_synced when there is no lastSync", () => {
    expect(conditionsFor(kiosk({ lastSync: undefined, health: undefined }))).toEqual(["never_synced"]);
  });

  it("flags device_fault for camera, model, or scan-blocking degraded reasons", () => {
    const reported = new Date(NOW - MINUTE).toISOString();
    expect(conditionsFor(kiosk({ health: { cameraOk: false, reportedAt: reported } }))).toEqual(["device_fault"]);
    expect(conditionsFor(kiosk({ health: { modelOk: false, reportedAt: reported } }))).toEqual(["device_fault"]);
    for (const reason of ["camera_error", "model_error", "encoding_mismatch", "no_workers_synced"]) {
      expect(conditionsFor(kiosk({ health: { degradedReason: reason, reportedAt: reported } }))).toEqual(["device_fault"]);
    }
    expect(conditionsFor(kiosk({ health: { degradedReason: "liveness_unavailable", reportedAt: reported } }))).toEqual([]);
  });

  it("flags queue_backlog at 50 or more queued logs", () => {
    const reported = new Date(NOW - MINUTE).toISOString();
    expect(conditionsFor(kiosk({ health: { queuedLogs: 49, reportedAt: reported } }))).toEqual([]);
    expect(conditionsFor(kiosk({ health: { queuedLogs: 50, reportedAt: reported } }))).toEqual(["queue_backlog"]);
  });

  it("combines independent conditions and skips inactive kiosks", () => {
    const broken = kiosk({
      lastSync: new Date(NOW - 20 * MINUTE).toISOString(),
      health: { cameraOk: false, queuedLogs: 80, reportedAt: new Date(NOW - 20 * MINUTE).toISOString() },
    });
    expect(conditionsFor(broken)).toEqual(["stale", "device_fault", "queue_backlog"]);
    expect(evaluateKioskAlerts([kiosk({ active: false, lastSync: undefined })], NOW)).toEqual([]);
  });

  it("honours custom thresholds", () => {
    const k = kiosk({ lastSync: new Date(NOW - 5 * MINUTE).toISOString() });
    expect(evaluateKioskAlerts([k], NOW, { ...DEFAULT_THRESHOLDS, staleMs: 4 * MINUTE })[0].conditions).toEqual(["stale"]);
  });
});

describe("planKioskNotifications", () => {
  it("notifies new conditions, reminds after 6 hours, and stays quiet in between", () => {
    const offline = kiosk({ lastSync: new Date(NOW - 2 * HOUR).toISOString() });
    const evaluations = evaluateKioskAlerts([offline], NOW);

    const fresh = planKioskNotifications(evaluations, [], NOW);
    expect(fresh.alerts).toHaveLength(1);
    expect(fresh.alerts[0].conditions).toEqual([{ condition: "offline", firstSeenAt: new Date(NOW).toISOString(), isNew: true }]);
    expect(fresh.observations).toEqual([{ kioskId: offline.kioskId, condition: "offline" }]);

    const firstSeenAt = new Date(NOW - 3 * HOUR).toISOString();
    const recentlyNotified = [{ kioskId: offline.kioskId, condition: "offline", firstSeenAt, lastNotifiedAt: new Date(NOW - HOUR).toISOString() }];
    expect(planKioskNotifications(evaluations, recentlyNotified, NOW).alerts).toEqual([]);

    const overdue = [{ kioskId: offline.kioskId, condition: "offline", firstSeenAt, lastNotifiedAt: new Date(NOW - RENOTIFY_INTERVAL_MS).toISOString() }];
    const reminder = planKioskNotifications(evaluations, overdue, NOW);
    expect(reminder.alerts[0].conditions).toEqual([{ condition: "offline", firstSeenAt, isNew: false }]);

    const neverNotified = [{ kioskId: offline.kioskId, condition: "offline", firstSeenAt }];
    expect(planKioskNotifications(evaluations, neverNotified, NOW).alerts).toHaveLength(1);
  });

  it("does not announce a stale recovery when the kiosk escalated to offline", () => {
    const offline = kiosk({ lastSync: new Date(NOW - 2 * HOUR).toISOString() });
    const staleRow = {
      kioskId: offline.kioskId,
      condition: "stale",
      firstSeenAt: new Date(NOW - 90 * MINUTE).toISOString(),
      lastNotifiedAt: new Date(NOW - 90 * MINUTE).toISOString(),
    };
    const plan = planKioskNotifications(evaluateKioskAlerts([offline], NOW), [staleRow], NOW);
    expect(plan.recoveries).toEqual([]);
    expect(plan.alerts.map((alert) => alert.conditions.map((item) => item.condition))).toEqual([["offline"]]);
  });

  it("sends one recovery for notified conditions that cleared and none for silent ones", () => {
    const healthy = kiosk();
    const rows = [
      { kioskId: healthy.kioskId, condition: "offline", firstSeenAt: new Date(NOW - 5 * HOUR).toISOString(), lastNotifiedAt: new Date(NOW - 5 * HOUR).toISOString() },
      { kioskId: healthy.kioskId, condition: "queue_backlog", firstSeenAt: new Date(NOW - 5 * HOUR).toISOString() },
    ];
    const plan = planKioskNotifications(evaluateKioskAlerts([healthy], NOW), rows, NOW);
    expect(plan.alerts).toEqual([]);
    expect(plan.recoveries).toHaveLength(1);
    expect(plan.recoveries[0].conditions.map((item) => item.condition)).toEqual(["offline"]);
  });
});

describe("alert messages and config", () => {
  it("builds a subject with the kiosk name and duration and links to /kiosks", () => {
    const offline = kiosk({ lastSync: new Date(NOW - 2 * HOUR).toISOString() });
    const plan = planKioskNotifications(
      evaluateKioskAlerts([offline], NOW),
      [{ kioskId: offline.kioskId, condition: "offline", firstSeenAt: new Date(NOW - 72 * MINUTE).toISOString() }],
      NOW,
    );
    const message = buildAlertMessage(plan.alerts[0], NOW, "https://example.test");
    expect(message.subject).toBe("[FW Gatekeeper] Main Entry offline for 1h 12m");
    expect(message.text).toContain("Location: Building A");
    expect(message.text).toContain("https://example.test/kiosks");
    expect(message.text).toContain("Last sync:");
  });

  it("reports which email variables are missing", () => {
    const config = readAlertConfig({ RESEND_API_KEY: "re_x", ALERT_EMAIL_TO: "a@x.test, b@x.test" });
    expect(config.email).toBeNull();
    expect(config.missingEmailVars).toEqual(["ALERT_EMAIL_FROM"]);
    expect(config.siteUrl).toBe("https://fw-gatekeeper.onrender.com");

    const full = readAlertConfig({
      RESEND_API_KEY: "re_x",
      ALERT_EMAIL_FROM: "alerts@x.test",
      ALERT_EMAIL_TO: "a@x.test, b@x.test",
      SITE_URL: "https://example.test/",
    });
    expect(full.email).toEqual({ apiKey: "re_x", from: "alerts@x.test", to: ["a@x.test", "b@x.test"] });
    expect(full.siteUrl).toBe("https://example.test");
  });
});

describe("alertState recording", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function seedStaleKiosk(ageMs: number) {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("kiosks", {
        name: "Main Entry",
        kioskId: "kiosk-1",
        type: "entry",
        location: "Building A",
        lastSync: new Date(Date.now() - ageMs).toISOString(),
        active: true,
      });
    });
    return t;
  }

  async function runRecording(t: ReturnType<typeof convexTest>, nowMs: number) {
    const { kiosks, openStates } = await t.query(internal.alerts.loadState, {});
    const plan = planKioskNotifications(evaluateKioskAlerts(kiosks, nowMs), openStates, nowMs);
    const notified = plan.alerts.flatMap((alert) =>
      alert.conditions.map((item) => ({ kioskId: alert.kiosk.kioskId, condition: item.condition })),
    );
    const recorded = await t.mutation(internal.alerts.recordState, {
      now: new Date(nowMs).toISOString(),
      observations: plan.observations,
      notified,
    });
    return { plan, recorded };
  }

  it("creates one row for a kiosk that last synced 2 h ago and does not duplicate it within 6 h", async () => {
    const t = await seedStaleKiosk(2 * HOUR);
    const firstRun = Date.now();

    const first = await runRecording(t, firstRun);
    expect(first.plan.alerts).toHaveLength(1);
    expect(first.recorded).toEqual({ created: 1, notified: 1, resolved: 0 });

    const rowsAfterFirst = await t.run((ctx) => ctx.db.query("alertState").collect());
    expect(rowsAfterFirst).toHaveLength(1);
    expect(rowsAfterFirst[0]).toMatchObject({ condition: "offline", lastNotifiedAt: new Date(firstRun).toISOString() });
    expect(rowsAfterFirst[0].resolvedAt).toBeUndefined();

    const second = await runRecording(t, firstRun + HOUR);
    expect(second.plan.alerts).toEqual([]);
    expect(second.recorded).toEqual({ created: 0, notified: 0, resolved: 0 });

    const rowsAfterSecond = await t.run((ctx) => ctx.db.query("alertState").collect());
    expect(rowsAfterSecond).toHaveLength(1);
    expect(rowsAfterSecond[0]._id).toBe(rowsAfterFirst[0]._id);
    expect(rowsAfterSecond[0].firstSeenAt).toBe(new Date(firstRun).toISOString());
  });

  it("checkKiosks records without notifying when delivery is unconfigured", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("ALERT_EMAIL_FROM", "");
    vi.stubEnv("ALERT_EMAIL_TO", "");
    vi.stubEnv("ALERT_WEBHOOK_URL", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const t = await seedStaleKiosk(2 * HOUR);
    const result = await t.action(internal.alerts.checkKiosks, {});
    expect(result).toMatchObject({ kiosks: 1, alerts: 1, recoveries: 0, delivered: 0, configured: false });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("kiosk_alerts_unconfigured", expect.objectContaining({
      missing: ["RESEND_API_KEY", "ALERT_EMAIL_FROM", "ALERT_EMAIL_TO"],
    }));

    const rows = await t.run((ctx) => ctx.db.query("alertState").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].lastNotifiedAt).toBeUndefined();
    warn.mockRestore();
  });

  it("checkKiosks emails through Resend once, then sends a single recovery notice", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("ALERT_EMAIL_FROM", "alerts@example.test");
    vi.stubEnv("ALERT_EMAIL_TO", "ops@example.test");
    vi.stubEnv("ALERT_WEBHOOK_URL", "");
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const t = await seedStaleKiosk(2 * HOUR);

    const first = await t.action(internal.alerts.checkKiosks, {});
    expect(first).toMatchObject({ alerts: 1, delivered: 1, configured: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer re_test");
    const body = JSON.parse(String(init.body));
    expect(body.to).toEqual(["ops@example.test"]);
    expect(body.subject).toMatch(/^\[FW Gatekeeper\] Main Entry offline for /);

    const second = await t.action(internal.alerts.checkKiosks, {});
    expect(second).toMatchObject({ alerts: 0, delivered: 0 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await t.run((ctx) => ctx.db.query("alertState").collect())).toHaveLength(1);

    await t.run(async (ctx) => {
      const [row] = await ctx.db.query("kiosks").collect();
      await ctx.db.patch(row._id, { lastSync: new Date().toISOString() });
    });
    const third = await t.action(internal.alerts.checkKiosks, {});
    expect(third).toMatchObject({ alerts: 0, recoveries: 1, delivered: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const recoveryBody = JSON.parse(String((fetchSpy.mock.calls[1] as unknown as [string, RequestInit])[1].body));
    expect(recoveryBody.subject).toBe("[FW Gatekeeper] Main Entry recovered: offline cleared");

    const rows = await t.run((ctx) => ctx.db.query("alertState").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].resolvedAt).toBeDefined();

    const fourth = await t.action(internal.alerts.checkKiosks, {});
    expect(fourth).toMatchObject({ alerts: 0, recoveries: 0, delivered: 0 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
  it("retries failed recovery delivery without repeating a successful recovery", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("ALERT_WEBHOOK_URL", "https://example.test/hook");
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const t = await seedStaleKiosk(2 * HOUR);
    await t.action(internal.alerts.checkKiosks, {});
    await t.run(async (ctx) => {
      const [row] = await ctx.db.query("kiosks").collect();
      await ctx.db.patch(row._id, { lastSync: new Date().toISOString() });
    });
    fetchSpy.mockResolvedValueOnce(new Response("failed", { status: 503 }));
    expect(await t.action(internal.alerts.checkKiosks, {})).toMatchObject({ recoveries: 1, delivered: 0 });
    const pending = await t.run((ctx) => ctx.db.query("alertState").collect());
    expect(pending[0].resolvedAt).toBeUndefined();
    expect(await t.action(internal.alerts.checkKiosks, {})).toMatchObject({ recoveries: 1, delivered: 1 });
    expect(await t.action(internal.alerts.checkKiosks, {})).toMatchObject({ recoveries: 0, delivered: 0 });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("retires deactivated kiosk alerts without announcing a recovery", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("ALERT_WEBHOOK_URL", "https://example.test/hook");
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const t = await seedStaleKiosk(2 * HOUR);
    await t.action(internal.alerts.checkKiosks, {});
    await t.run(async (ctx) => {
      const [row] = await ctx.db.query("kiosks").collect();
      await ctx.db.patch(row._id, { active: false });
    });
    expect(await t.action(internal.alerts.checkKiosks, {})).toMatchObject({ kiosks: 0, recoveries: 0, delivered: 0 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [state] = await t.run((ctx) => ctx.db.query("alertState").collect());
    expect(state.resolvedAt).toBeDefined();
  });

});
