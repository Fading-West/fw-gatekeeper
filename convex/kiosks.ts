import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { ConvexError, v } from "convex/values";
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

/**
 * Supplies the credential-free Convex HTTP health action with the minimum
 * fields needed to aggregate fleet status. It is not callable through api.*.
 */
export const internalHealthSnapshot = internalQuery({
  args: {},
  returns: v.array(v.object({
    last_sync: v.union(v.string(), v.null()),
    health: healthSerialized,
  })),
  handler: async (ctx) => {
    const kiosks = await ctx.db
      .query("kiosks")
      .withIndex("by_active", (q) => q.eq("active", true))
      .take(101);
    return kiosks.map((kiosk) => ({
      last_sync: kiosk.lastSync ?? null,
      health: serializeHealth(kiosk.health),
    }));
  },
});

export const create = mutation({
  args: { name: v.string(), kioskId: v.optional(v.string()), type: v.string(), location: v.optional(v.string()) },
  returns: v.object({ id: v.id("kiosks"), name: v.string(), type: v.string() }),
  handler: async (ctx, args) => {
    await assertPortalRole(ctx, ["admin"]);

    const name = args.name.trim();
    if (!name) {
      throw new ConvexError({ code: "INVALID_KIOSK_NAME", message: "Kiosk name required" });
    }
    const kioskId = normalizeOptionalText(args.kioskId);
    // Legacy names and sync IDs are case-insensitive aliases. Check the whole
    // bounded active fleet in this transaction so concurrent creates conflict.
    const kiosks = await ctx.db.query("kiosks")
      .withIndex("by_active", (q) => q.eq("active", true))
      .take(1001);
    if (kiosks.length >= 1000) {
      throw new ConvexError({ code: "KIOSK_FLEET_LIMIT", message: "Kiosk registration supports up to 1,000 active kiosks. Contact an administrator before adding more." });
    }
    const aliases = new Set([name, kioskId].filter((value): value is string => !!value)
      .map((value) => value.toLowerCase()));
    if (kiosks.some((kiosk) => [kiosk.name, kiosk.kioskId, kiosk._id]
      .some((value) => value && aliases.has(value.trim().toLowerCase())))) {
      throw new ConvexError({ code: "KIOSK_IDENTIFIER_CONFLICT", message: "Kiosk name or sync ID is already used by another active kiosk. Choose a unique name and sync ID." });
    }
    const id = await ctx.db.insert("kiosks", {
      name,
      kioskId,
      type: args.type.trim(),
      location: normalizeOptionalText(args.location) || "",
      active: true,
    });
    return { id, name, type: args.type.trim() };
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
