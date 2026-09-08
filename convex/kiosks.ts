import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { assertPortalRole } from "./access";
import { findActiveKioskByIdentifier } from "./kioskLookup";

function normalizeOptionalText(value?: string) {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function serializeHealth(health: any) {
  if (!health) return null;
  return {
    camera_ok: health.cameraOk ?? null,
    model_ok: health.modelOk ?? null,
    liveness_available: health.livenessAvailable ?? null,
    known_workers: health.knownWorkers ?? null,
    queued_logs: health.queuedLogs ?? null,
    queued_attempts: health.queuedAttempts ?? null,
    degraded_reason: health.degradedReason ?? null,
    last_scan_at: health.lastScanAt ?? null,
    reported_at: health.reportedAt,
  };
}

function serializeKiosk(k: any) {
  return {
    id: k._id,
    name: k.name,
    kiosk_id: k.kioskId || null,
    type: k.type,
    location: k.location,
    last_sync: k.lastSync || null,
    health: serializeHealth(k.health),
    active: 1,
  };
}

const healthSerialized = v.union(v.object({
  camera_ok: v.union(v.boolean(), v.null()),
  model_ok: v.union(v.boolean(), v.null()),
  liveness_available: v.union(v.boolean(), v.null()),
  known_workers: v.union(v.float64(), v.null()),
  queued_logs: v.union(v.float64(), v.null()),
  queued_attempts: v.union(v.float64(), v.null()),
  degraded_reason: v.union(v.string(), v.null()),
  last_scan_at: v.union(v.string(), v.null()),
  reported_at: v.string(),
}), v.null());

const healthInput = v.object({
  cameraOk: v.optional(v.boolean()),
  modelOk: v.optional(v.boolean()),
  livenessAvailable: v.optional(v.boolean()),
  knownWorkers: v.optional(v.float64()),
  queuedLogs: v.optional(v.float64()),
  queuedAttempts: v.optional(v.float64()),
  degradedReason: v.optional(v.string()),
  lastScanAt: v.optional(v.string()),
  reportedAt: v.string(),
});

export const list = query({
  args: {},
  returns: v.array(v.object({
    id: v.id("kiosks"),
    name: v.string(),
    kiosk_id: v.union(v.string(), v.null()),
    type: v.string(),
    location: v.string(),
    last_sync: v.union(v.string(), v.null()),
    health: healthSerialized,
    active: v.number(),
  })),
  handler: async (ctx) => {
    await assertPortalRole(ctx, ["admin", "enrollment", "viewer"]);

    const kiosks = await ctx.db
      .query("kiosks")
      .withIndex("by_active", (q) => q.eq("active", true))
      .collect();
    return kiosks.map(serializeKiosk);
  },
});

type PublicKioskStatus = "online" | "stale" | "offline" | "never_synced";

function publicKioskStatus(lastSync: string | undefined, now: number): PublicKioskStatus {
  if (!lastSync) return "never_synced";
  const ageMs = now - new Date(lastSync).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs <= 15 * 60 * 1000) return "online";
  if (ageMs <= 60 * 60 * 1000) return "stale";
  return "offline";
}

/**
 * Credential-free, aggregate-only health for external availability monitors.
 * Deliberately excludes kiosk identifiers, names, locations, workers, scans,
 * schedules, attendance records, and recognition details.
 */
export const publicHealthSummary = query({
  args: { checkedAtMs: v.float64() },
  returns: v.object({
    status: v.union(v.literal("healthy"), v.literal("degraded")),
    timestamp: v.string(),
    kiosks: v.object({
      total: v.float64(),
      online: v.float64(),
      stale: v.float64(),
      offline: v.float64(),
      never_synced: v.float64(),
      reporting_device_health: v.float64(),
      missing_device_health: v.float64(),
      stale_device_health: v.float64(),
      device_issues: v.float64(),
      queued_records: v.float64(),
      inventory_truncated: v.boolean(),
    }),
  }),
  handler: async (ctx, args) => {
    const now = args.checkedAtMs;
    const kioskPage = await ctx.db
      .query("kiosks")
      .withIndex("by_active", (q) => q.eq("active", true))
      .take(101);
    const inventoryTruncated = kioskPage.length > 100;
    const kiosks = kioskPage.slice(0, 100);
    const counts = { online: 0, stale: 0, offline: 0, never_synced: 0 };
    let reportingDeviceHealth = 0;
    let missingDeviceHealth = 0;
    let staleDeviceHealth = 0;
    let deviceIssues = 0;
    let queuedRecords = 0;

    for (const kiosk of kiosks) {
      counts[publicKioskStatus(kiosk.lastSync, now)] += 1;
      if (!kiosk.health) {
        missingDeviceHealth += 1;
        continue;
      }
      const healthAgeMs = now - new Date(kiosk.health.reportedAt).getTime();
      if (!Number.isFinite(healthAgeMs) || healthAgeMs < 0 || healthAgeMs > 15 * 60 * 1000) {
        staleDeviceHealth += 1;
        continue;
      }
      reportingDeviceHealth += 1;
      if (kiosk.health.cameraOk === false || kiosk.health.modelOk === false || kiosk.health.degradedReason) {
        deviceIssues += 1;
      }
      queuedRecords += Math.max(0, kiosk.health.queuedLogs ?? 0) + Math.max(0, kiosk.health.queuedAttempts ?? 0);
    }

    const degraded = kiosks.length === 0
      || inventoryTruncated
      || counts.stale + counts.offline + counts.never_synced > 0
      || missingDeviceHealth + staleDeviceHealth > 0
      || deviceIssues > 0
      || queuedRecords > 0;
    return {
      status: degraded ? "degraded" as const : "healthy" as const,
      timestamp: new Date(now).toISOString(),
      kiosks: {
        total: kiosks.length,
        ...counts,
        reporting_device_health: reportingDeviceHealth,
        missing_device_health: missingDeviceHealth,
        stale_device_health: staleDeviceHealth,
        device_issues: deviceIssues,
        queued_records: queuedRecords,
        inventory_truncated: inventoryTruncated,
      },
    };
  },
});

export const create = mutation({
  args: { name: v.string(), kioskId: v.optional(v.string()), type: v.string(), location: v.optional(v.string()) },
  returns: v.object({ id: v.id("kiosks"), name: v.string(), type: v.string() }),
  handler: async (ctx, args) => {
    await assertPortalRole(ctx, ["admin"]);

    const kioskId = normalizeOptionalText(args.kioskId);
    const id = await ctx.db.insert("kiosks", {
      name: args.name.trim(),
      kioskId,
      type: args.type.trim(),
      location: normalizeOptionalText(args.location) || "",
      active: true,
    });
    return { id, name: args.name, type: args.type };
  },
});

export const updateLastSyncFromHttp = internalMutation({
  args: { kioskId: v.string(), lastSync: v.string(), health: v.optional(healthInput) },
  returns: v.object({ updated: v.boolean() }),
  handler: async (ctx, args) => {
    const kiosk = await findActiveKioskByIdentifier(ctx, args.kioskId);
    if (!kiosk) return { updated: false };

    await ctx.db.patch(kiosk._id, {
      lastSync: args.lastSync,
      ...(args.health ? { health: args.health } : {}),
    });
    return { updated: true };
  },
});
