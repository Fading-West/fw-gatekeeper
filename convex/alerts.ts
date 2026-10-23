import { getKioskDegradedReasons } from "../src/lib/kiosk-health-reasons";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";

// Kiosk alerting (audit finding R2). Runs from convex/crons.ts every 15 minutes
// so somebody hears about a dead kiosk at 3 a.m. instead of at shift start.
// The evaluation and planning helpers below are pure so they can be unit
// tested without a Convex context; only `checkKiosks` talks to the network.
//
// Thresholds mirror src/app/api/system-health/route.ts (online <= 15 min,
// stale <= 60 min, offline beyond) and the scan-blocking degraded reasons in
// convex/shiftBriefing.ts, so the email says the same thing the dashboard does.
//
// This module is read-only with respect to kiosks (vision.md principle 6): it
// never touches lastSync or health, it only records its own alertState rows.

export const STALE_THRESHOLD_MS = 15 * 60 * 1000;
export const OFFLINE_THRESHOLD_MS = 60 * 60 * 1000;
export const QUEUE_BACKLOG_THRESHOLD = 50;
export const RENOTIFY_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_SITE_URL = "https://fw-gatekeeper.onrender.com";

export const SCAN_BLOCKING_DEGRADED_REASONS = new Set([
  "camera_error",
  "model_error",
  "encoding_mismatch",
  "no_workers_synced",
  "liveness_required_unavailable",
]);

// Ordered by severity; the first matching condition drives the email subject.
export const ALERT_CONDITIONS = ["offline", "never_synced", "device_fault", "stale", "queue_backlog"] as const;
export type AlertCondition = (typeof ALERT_CONDITIONS)[number];

export type AlertKioskHealth = {
  cameraOk?: boolean;
  modelOk?: boolean;
  livenessAvailable?: boolean;
  knownWorkers?: number;
  queuedLogs?: number;
  queuedAttempts?: number;
  degradedReason?: string;
  lastScanAt?: string;
  reportedAt: string;
};

export type AlertKiosk = {
  kioskId: string;
  name: string;
  location: string;
  deviceId?: string;
  lastSync?: string;
  health?: AlertKioskHealth;
  active?: boolean;
};

export type AlertThresholds = {
  staleMs: number;
  offlineMs: number;
  queueBacklog: number;
};

export const DEFAULT_THRESHOLDS: AlertThresholds = {
  staleMs: STALE_THRESHOLD_MS,
  offlineMs: OFFLINE_THRESHOLD_MS,
  queueBacklog: QUEUE_BACKLOG_THRESHOLD,
};

export type KioskAlertEvaluation = {
  kiosk: AlertKiosk;
  conditions: AlertCondition[];
  lastSyncAgeMs: number | null;
};

export type AlertStateRow = {
  kioskId: string;
  condition: string;
  firstSeenAt: string;
  lastNotifiedAt?: string;
  resolvedAt?: string;
};

export type PlannedAlert = {
  kiosk: AlertKiosk;
  evaluation: KioskAlertEvaluation;
  conditions: Array<{ condition: AlertCondition; firstSeenAt: string; isNew: boolean }>;
};

export type PlannedRecovery = {
  kiosk: AlertKiosk;
  conditions: Array<{ condition: string; firstSeenAt: string }>;
};

export type AlertPlan = {
  observations: Array<{ kioskId: string; condition: string }>;
  alerts: PlannedAlert[];
  recoveries: PlannedRecovery[];
};

function hasScanBlockingFault(health?: AlertKioskHealth): boolean {
  if (!health) return false;
  if (health.cameraOk === false || health.modelOk === false) return true;
  return getKioskDegradedReasons(health.degradedReason).some(reason => SCAN_BLOCKING_DEGRADED_REASONS.has(reason));
}

/**
 * Evaluate every active kiosk against the alert thresholds.
 *
 * `stale` and `offline` are mutually exclusive: a kiosk past the offline
 * threshold reports only `offline`, so a stale alert can never fire alongside
 * an offline one for the same kiosk.
 */
export function evaluateKioskAlerts(
  kiosks: AlertKiosk[],
  nowMs: number,
  thresholds: AlertThresholds = DEFAULT_THRESHOLDS,
): KioskAlertEvaluation[] {
  const evaluations: KioskAlertEvaluation[] = [];

  for (const kiosk of kiosks) {
    if (kiosk.active === false) continue;

    const conditions: AlertCondition[] = [];
    let lastSyncAgeMs: number | null = null;

    if (!kiosk.lastSync) {
      conditions.push("never_synced");
    } else {
      const lastSyncMs = new Date(kiosk.lastSync).getTime();
      if (!Number.isFinite(lastSyncMs) || lastSyncMs > nowMs) {
        conditions.push("stale");
      } else {
        lastSyncAgeMs = nowMs - lastSyncMs;
        if (lastSyncAgeMs > thresholds.offlineMs) {
          conditions.push("offline");
        } else if (lastSyncAgeMs > thresholds.staleMs) {
          conditions.push("stale");
        }
      }
    }

    if (hasScanBlockingFault(kiosk.health)) {
      conditions.push("device_fault");
    }
    if ((kiosk.health?.queuedLogs ?? 0) >= thresholds.queueBacklog) {
      conditions.push("queue_backlog");
    }

    evaluations.push({ kiosk, conditions, lastSyncAgeMs });
  }

  return evaluations;
}

function stateKey(kioskId: string, condition: string) {
  return `${kioskId}\u0000${condition}`;
}

/**
 * Compare fresh evaluations with the open alertState rows and decide what to
 * record, what to notify, and what to announce as recovered.
 *
 * - A condition is notified when it has never been notified (new, or first
 *   seen while delivery was unconfigured) or when its last notification is
 *   older than `renotifyMs`.
 * - A cleared condition produces a recovery only if it was actually notified.
 *   A `stale` episode that escalated straight into `offline` is not a
 *   recovery, so it is folded into the offline alert instead.
 */
export function planKioskNotifications(
  evaluations: KioskAlertEvaluation[],
  openStates: AlertStateRow[],
  nowMs: number,
  renotifyMs: number = RENOTIFY_INTERVAL_MS,
): AlertPlan {
  const nowIso = new Date(nowMs).toISOString();
  const openByKey = new Map<string, AlertStateRow>();
  for (const row of openStates) {
    if (row.resolvedAt) continue;
    openByKey.set(stateKey(row.kioskId, row.condition), row);
  }

  const observations: AlertPlan["observations"] = [];
  const alerts: PlannedAlert[] = [];
  const observedKeys = new Set<string>();
  const kiosksById = new Map<string, KioskAlertEvaluation>();

  for (const evaluation of evaluations) {
    kiosksById.set(evaluation.kiosk.kioskId, evaluation);
    const due: PlannedAlert["conditions"] = [];

    for (const condition of evaluation.conditions) {
      const key = stateKey(evaluation.kiosk.kioskId, condition);
      observedKeys.add(key);
      observations.push({ kioskId: evaluation.kiosk.kioskId, condition });

      const existing = openByKey.get(key);
      const lastNotifiedMs = existing?.lastNotifiedAt ? new Date(existing.lastNotifiedAt).getTime() : NaN;
      const shouldNotify = !Number.isFinite(lastNotifiedMs) || nowMs - lastNotifiedMs >= renotifyMs;
      if (shouldNotify) {
        due.push({ condition, firstSeenAt: existing?.firstSeenAt ?? nowIso, isNew: !existing });
      }
    }

    if (due.length > 0) {
      alerts.push({ kiosk: evaluation.kiosk, evaluation, conditions: due });
    }
  }

  const recoveriesByKiosk = new Map<string, PlannedRecovery>();
  for (const row of openStates) {
    if (row.resolvedAt) continue;
    const key = stateKey(row.kioskId, row.condition);
    if (observedKeys.has(key)) continue;
    if (!row.lastNotifiedAt) continue;

    const current = kiosksById.get(row.kioskId);
    if (!current) continue; // Retiring a kiosk is not evidence that it recovered.
    const escalatedToOffline = row.condition === "stale" && current?.conditions.includes("offline");
    if (escalatedToOffline) continue;

    const kiosk: AlertKiosk = current?.kiosk ?? { kioskId: row.kioskId, name: row.kioskId, location: "" };
    const recovery = recoveriesByKiosk.get(row.kioskId) ?? { kiosk, conditions: [] };
    recovery.conditions.push({ condition: row.condition, firstSeenAt: row.firstSeenAt });
    recoveriesByKiosk.set(row.kioskId, recovery);
  }

  return { observations, alerts, recoveries: Array.from(recoveriesByKiosk.values()) };
}

export function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

const CONDITION_LABELS: Record<string, string> = {
  offline: "offline",
  stale: "stale",
  never_synced: "never synced",
  device_fault: "device fault",
  queue_backlog: "queue backlog",
};

function conditionSummary(condition: string, kiosk: AlertKiosk, sinceMs: number): string {
  const duration = formatDuration(sinceMs);
  switch (condition) {
    case "offline":
      return `offline for ${duration}`;
    case "stale":
      return `stale for ${duration}`;
    case "never_synced":
      return `has never synced (flagged ${duration} ago)`;
    case "device_fault":
      return `reporting a scan-blocking device fault for ${duration}`;
    case "queue_backlog":
      return `holding ${kiosk.health?.queuedLogs ?? "many"} queued logs for ${duration}`;
    default:
      return `${CONDITION_LABELS[condition] ?? condition} for ${duration}`;
  }
}

function conditionRank(condition: string) {
  const index = (ALERT_CONDITIONS as readonly string[]).indexOf(condition);
  return index === -1 ? ALERT_CONDITIONS.length : index;
}

function describeAge(iso: string | undefined, nowMs: number) {
  if (!iso) return "never";
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return iso;
  return `${iso} (${formatDuration(nowMs - ms)} ago)`;
}

export type AlertMessage = {
  kind: "alert" | "recovery";
  kiosk: AlertKiosk;
  conditions: string[];
  subject: string;
  text: string;
};

export function buildAlertMessage(alert: PlannedAlert, nowMs: number, siteUrl: string): AlertMessage {
  const sorted = [...alert.conditions].sort((a, b) => conditionRank(a.condition) - conditionRank(b.condition));
  const primary = sorted[0];
  const primarySince = nowMs - new Date(primary.firstSeenAt).getTime();
  const extra = sorted.length > 1 ? ` (+${sorted.length - 1} more)` : "";
  const subject = `[FW Gatekeeper] ${alert.kiosk.name} ${conditionSummary(primary.condition, alert.kiosk, primarySince)}${extra}`;

  const health = alert.kiosk.health;
  const lines = [
    `Kiosk: ${alert.kiosk.name}`,
    `Location: ${alert.kiosk.location || "(not set)"}`,
    `Kiosk ID: ${alert.kiosk.deviceId || alert.kiosk.kioskId}`,
    "",
    "Conditions:",
    ...sorted.map((item) => {
      const since = nowMs - new Date(item.firstSeenAt).getTime();
      const state = item.isNew ? "new" : "still active";
      return `  - ${CONDITION_LABELS[item.condition] ?? item.condition}: since ${item.firstSeenAt} (${formatDuration(since)}, ${state})`;
    }),
    "",
    `Last sync: ${describeAge(alert.kiosk.lastSync, nowMs)}`,
    `Degraded reason: ${health?.degradedReason ?? "none reported"}`,
    `Camera OK: ${health?.cameraOk ?? "unknown"}`,
    `Model OK: ${health?.modelOk ?? "unknown"}`,
    `Queued logs on device: ${health?.queuedLogs ?? "unknown"}`,
    `Health reported at: ${describeAge(health?.reportedAt, nowMs)}`,
    "",
    `Kiosk readiness: ${siteUrl}/kiosks`,
    `Checked at: ${new Date(nowMs).toISOString()}`,
    "",
    "Reminders repeat every 6 hours while the condition persists. You will get one recovery notice when it clears.",
  ];

  return {
    kind: "alert",
    kiosk: alert.kiosk,
    conditions: sorted.map((item) => item.condition),
    subject,
    text: lines.join("\n"),
  };
}

export function buildRecoveryMessage(recovery: PlannedRecovery, nowMs: number, siteUrl: string): AlertMessage {
  const sorted = [...recovery.conditions].sort((a, b) => conditionRank(a.condition) - conditionRank(b.condition));
  const labels = sorted.map((item) => CONDITION_LABELS[item.condition] ?? item.condition);
  const subject = `[FW Gatekeeper] ${recovery.kiosk.name} recovered: ${labels.join(", ")} cleared`;
  const lines = [
    `Kiosk: ${recovery.kiosk.name}`,
    `Location: ${recovery.kiosk.location || "(not set)"}`,
    `Kiosk ID: ${recovery.kiosk.deviceId || recovery.kiosk.kioskId}`,
    "",
    "Cleared conditions:",
    ...sorted.map((item) => {
      const lasted = nowMs - new Date(item.firstSeenAt).getTime();
      return `  - ${CONDITION_LABELS[item.condition] ?? item.condition}: first seen ${item.firstSeenAt}, lasted ${formatDuration(lasted)}`;
    }),
    "",
    `Last sync: ${describeAge(recovery.kiosk.lastSync, nowMs)}`,
    `Kiosk readiness: ${siteUrl}/kiosks`,
    `Checked at: ${new Date(nowMs).toISOString()}`,
  ];

  return {
    kind: "recovery",
    kiosk: recovery.kiosk,
    conditions: sorted.map((item) => item.condition),
    subject,
    text: lines.join("\n"),
  };
}

export type AlertDeliveryConfig = {
  email: { apiKey: string; from: string; to: string[] } | null;
  missingEmailVars: string[];
  webhookUrl: string | null;
  siteUrl: string;
};

export function readAlertConfig(env: Record<string, string | undefined>): AlertDeliveryConfig {
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.ALERT_EMAIL_FROM?.trim();
  const to = (env.ALERT_EMAIL_TO ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);

  const missingEmailVars = [
    ...(apiKey ? [] : ["RESEND_API_KEY"]),
    ...(from ? [] : ["ALERT_EMAIL_FROM"]),
    ...(to.length ? [] : ["ALERT_EMAIL_TO"]),
  ];

  return {
    email: apiKey && from && to.length ? { apiKey, from, to } : null,
    missingEmailVars,
    webhookUrl: env.ALERT_WEBHOOK_URL?.trim() || null,
    siteUrl: (env.SITE_URL?.trim() || DEFAULT_SITE_URL).replace(/\/$/, ""),
  };
}

async function sendEmail(config: NonNullable<AlertDeliveryConfig["email"]>, message: AlertMessage) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: config.from,
      to: config.to,
      subject: message.subject,
      text: message.text,
    }),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(`Resend responded ${response.status}: ${detail}`);
  }
}

async function sendWebhook(url: string, message: AlertMessage, checkedAt: string, siteUrl: string) {
  const response = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: "fw-gatekeeper",
      type: message.kind === "alert" ? "kiosk_alert" : "kiosk_recovery",
      kiosk: {
        id: message.kiosk.kioskId,
        kiosk_id: message.kiosk.deviceId ?? null,
        name: message.kiosk.name,
        location: message.kiosk.location,
        last_sync: message.kiosk.lastSync ?? null,
        degraded_reason: message.kiosk.health?.degradedReason ?? null,
      },
      conditions: message.conditions,
      subject: message.subject,
      text: message.text,
      link: `${siteUrl}/kiosks`,
      checked_at: checkedAt,
    }),
  });
  if (!response.ok) {
    throw new Error(`Webhook responded ${response.status}`);
  }
}

/** Returns true when at least one channel accepted the message. */
async function deliver(config: AlertDeliveryConfig, message: AlertMessage, checkedAt: string): Promise<boolean> {
  let delivered = false;

  if (config.email) {
    try {
      await sendEmail(config.email, message);
      delivered = true;
    } catch (error) {
      console.error("kiosk_alerts_email_failed", { kiosk: message.kiosk.name, error: String(error) });
    }
  }

  if (config.webhookUrl) {
    try {
      await sendWebhook(config.webhookUrl, message, checkedAt, config.siteUrl);
      delivered = true;
    } catch (error) {
      console.error("kiosk_alerts_webhook_failed", { kiosk: message.kiosk.name, error: String(error) });
    }
  }

  return delivered;
}

const alertKioskValidator = v.object({
  kioskId: v.string(),
  name: v.string(),
  location: v.string(),
  deviceId: v.optional(v.string()),
  lastSync: v.optional(v.string()),
  health: v.optional(v.object({
    cameraOk: v.optional(v.boolean()),
    modelOk: v.optional(v.boolean()),
    livenessAvailable: v.optional(v.boolean()),
    knownWorkers: v.optional(v.float64()),
    queuedLogs: v.optional(v.float64()),
    queuedAttempts: v.optional(v.float64()),
    degradedReason: v.optional(v.string()),
    lastScanAt: v.optional(v.string()),
    reportedAt: v.string(),
  })),
  active: v.optional(v.boolean()),
});

const alertStateValidator = v.object({
  kioskId: v.string(),
  condition: v.string(),
  firstSeenAt: v.string(),
  lastNotifiedAt: v.optional(v.string()),
  resolvedAt: v.optional(v.string()),
});

const observationValidator = v.object({ kioskId: v.string(), condition: v.string() });

/** Active kiosks plus every unresolved alertState row. Read-only. */
export const loadState = internalQuery({
  args: {},
  returns: v.object({
    kiosks: v.array(alertKioskValidator),
    openStates: v.array(alertStateValidator),
  }),
  handler: async (ctx) => {
    const kiosks = await ctx.db
      .query("kiosks")
      .withIndex("by_active", (q) => q.eq("active", true))
      .collect();
    const openRows = await ctx.db
      .query("alertState")
      .withIndex("by_resolved", (q) => q.eq("resolvedAt", undefined))
      .collect();

    return {
      kiosks: kiosks.map((kiosk) => ({
        kioskId: kiosk._id as string,
        name: kiosk.name,
        location: kiosk.location,
        deviceId: kiosk.kioskId,
        lastSync: kiosk.lastSync,
        health: kiosk.health,
        active: kiosk.active,
      })),
      openStates: openRows.map((row) => ({
        kioskId: row.kioskId,
        condition: row.condition,
        firstSeenAt: row.firstSeenAt,
        lastNotifiedAt: row.lastNotifiedAt,
        resolvedAt: row.resolvedAt,
      })),
    };
  },
});

/**
 * Reconcile alertState with what the cron just observed:
 * - open a row for each observed (kiosk, condition) that has no open row,
 * - stamp lastNotifiedAt on the ones that were successfully delivered,
 * - resolve every open row that was not observed this run.
 */
export const recordState = internalMutation({
  args: {
    now: v.string(),
    observations: v.array(observationValidator),
    notified: v.array(observationValidator),
    recovered: v.optional(v.array(observationValidator)),
    retiredKioskIds: v.optional(v.array(v.string())),
  },
  returns: v.object({ created: v.number(), notified: v.number(), resolved: v.number() }),
  handler: async (ctx, args) => {
    const openRows = await ctx.db
      .query("alertState")
      .withIndex("by_resolved", (q) => q.eq("resolvedAt", undefined))
      .collect();
    const openByKey = new Map(openRows.map((row) => [stateKey(row.kioskId, row.condition), row]));
    const notifiedKeys = new Set(args.notified.map((item) => stateKey(item.kioskId, item.condition)));
    const retiredKioskIds = new Set(args.retiredKioskIds ?? []);
    const recoveredKeys = new Set((args.recovered ?? []).map((item) => stateKey(item.kioskId, item.condition)));
    const observedKeys = new Set<string>();

    let created = 0;
    let notified = 0;
    let resolved = 0;

    for (const observation of args.observations) {
      const key = stateKey(observation.kioskId, observation.condition);
      if (observedKeys.has(key)) continue;
      observedKeys.add(key);

      const existing = openByKey.get(key);
      const shouldStamp = notifiedKeys.has(key);
      if (existing) {
        if (shouldStamp) {
          await ctx.db.patch(existing._id, { lastNotifiedAt: args.now });
          notified += 1;
        }
        continue;
      }

      await ctx.db.insert("alertState", {
        kioskId: observation.kioskId,
        condition: observation.condition,
        firstSeenAt: args.now,
        ...(shouldStamp ? { lastNotifiedAt: args.now } : {}),
      });
      created += 1;
      if (shouldStamp) notified += 1;
    }

    for (const row of openRows) {
      if (observedKeys.has(stateKey(row.kioskId, row.condition))) continue;
      // Retain a cleared alert until its recovery was delivered, so network
      // failures retry next run. Escalation is not a recovery notification.
      const escalated = row.condition === "stale" && observedKeys.has(stateKey(row.kioskId, "offline"));
      if (row.lastNotifiedAt && !retiredKioskIds.has(row.kioskId) && !escalated && !recoveredKeys.has(stateKey(row.kioskId, row.condition))) continue;
      await ctx.db.patch(row._id, { resolvedAt: args.now });
      resolved += 1;
    }

    return { created, notified, resolved };
  },
});

export const checkKiosks = internalAction({
  args: {},
  returns: v.object({
    kiosks: v.number(),
    alerts: v.number(),
    recoveries: v.number(),
    delivered: v.number(),
    configured: v.boolean(),
  }),
  handler: async (ctx): Promise<{ kiosks: number; alerts: number; recoveries: number; delivered: number; configured: boolean }> => {
    const { kiosks, openStates } = await ctx.runQuery(internal.alerts.loadState, {});
    // A sync committed while loading must not look like a future timestamp.
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const evaluations = evaluateKioskAlerts(kiosks, nowMs);
    const plan = planKioskNotifications(evaluations, openStates, nowMs);
    const config = readAlertConfig(process.env);
    const configured = Boolean(config.email || config.webhookUrl);

    const notified: Array<{ kioskId: string; condition: string }> = [];
    const recovered: Array<{ kioskId: string; condition: string }> = [];
    let delivered = 0;

    if (plan.alerts.length > 0 || plan.recoveries.length > 0) {
      if (config.missingEmailVars.length > 0) {
        console.warn("kiosk_alerts_unconfigured", {
          missing: config.missingEmailVars,
          webhook: Boolean(config.webhookUrl),
          wouldAlert: plan.alerts.map((alert) => ({
            kiosk: alert.kiosk.name,
            conditions: alert.conditions.map((item) => item.condition),
          })),
          wouldRecover: plan.recoveries.map((recovery) => ({
            kiosk: recovery.kiosk.name,
            conditions: recovery.conditions.map((item) => item.condition),
          })),
        });
      }

      if (configured) {
        for (const alert of plan.alerts) {
          const message = buildAlertMessage(alert, nowMs, config.siteUrl);
          if (await deliver(config, message, now)) {
            delivered += 1;
            for (const item of alert.conditions) {
              notified.push({ kioskId: alert.kiosk.kioskId, condition: item.condition });
            }
          }
        }
        for (const recovery of plan.recoveries) {
          const message = buildRecoveryMessage(recovery, nowMs, config.siteUrl);
          if (await deliver(config, message, now)) {
            delivered += 1;
            for (const item of recovery.conditions) recovered.push({ kioskId: recovery.kiosk.kioskId, condition: item.condition });
          }
        }
      }
    }

    const recorded = await ctx.runMutation(internal.alerts.recordState, {
      now,
      observations: plan.observations,
      notified,
      recovered,
      retiredKioskIds: [...new Set(openStates.map((state) => state.kioskId))].filter((id) => !kiosks.some((kiosk) => kiosk.kioskId === id)),
    });

    console.info("kiosk_alerts_checked", {
      kiosks: kiosks.length,
      alerts: plan.alerts.length,
      recoveries: plan.recoveries.length,
      delivered,
      configured,
      ...recorded,
    });

    return {
      kiosks: kiosks.length,
      alerts: plan.alerts.length,
      recoveries: plan.recoveries.length,
      delivered,
      configured,
    };
  },
});
