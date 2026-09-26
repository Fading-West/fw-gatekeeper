import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { assertPortalRole } from "./access";
import { findActiveKioskByIdentifier } from "./kioskLookup";
import type { Doc } from "./_generated/dataModel";

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
    credential_status: (k.credentialHash ? "device" : k.legacyDisabledAt ? "revoked" : "legacy") as "device" | "revoked" | "legacy",
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
    credential_status: v.union(v.literal("device"), v.literal("revoked"), v.literal("legacy")),
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

const deviceIdentity = v.union(v.null(), v.object({
  documentId: v.id("kiosks"),
  kioskId: v.string(),
  aliases: v.array(v.string()),
}));

function identityFor(kiosk: Pick<Doc<"kiosks">, "_id" | "name" | "kioskId">) {
  return { documentId: kiosk._id, kioskId: kiosk.kioskId || kiosk._id, aliases: [kiosk._id, kiosk.name, ...(kiosk.kioskId ? [kiosk.kioskId] : [])] };
}

// The caller must prove possession of the random secret before using this
// lookup. Its SHA-256 digest is indexed; plaintext is never stored.
export const authenticateDevice = internalQuery({
  args: { credentialHash: v.string() },
  returns: deviceIdentity,
  handler: async (ctx, args) => {
    const kiosk = await ctx.db.query("kiosks")
      .withIndex("by_credential_hash", q => q.eq("credentialHash", args.credentialHash)).unique();
    return kiosk?.active ? identityFor(kiosk) : null;
  },
});

// The Next route checks the configured shared key before this lookup. New
// credentials permanently close this migration path for their kiosk.
export const authenticateLegacy = internalQuery({
  args: { identifier: v.string() },
  returns: deviceIdentity,
  handler: async (ctx, args) => {
    const kiosk = await findActiveKioskByIdentifier(ctx, args.identifier);
    return kiosk && !kiosk.legacyDisabledAt ? identityFor(kiosk) : null;
  },
});

export const rotateCredential = mutation({
  args: { id: v.id("kiosks"), credentialHash: v.string() },
  returns: v.object({ kioskId: v.string() }),
  handler: async (ctx, args) => {
    const actor = await assertPortalRole(ctx, ["admin"]);
    const kiosk = await ctx.db.get(args.id);
    if (!kiosk?.active) throw new ConvexError({ code: "KIOSK_NOT_FOUND", message: "Active kiosk not found" });
    if (!/^[a-f0-9]{64}$/.test(args.credentialHash)) throw new ConvexError({ code: "INVALID_CREDENTIAL", message: "Invalid credential hash" });
    const duplicate = await ctx.db.query("kiosks")
      .withIndex("by_credential_hash", q => q.eq("credentialHash", args.credentialHash)).unique();
    if (duplicate && duplicate._id !== args.id) throw new ConvexError({ code: "INVALID_CREDENTIAL", message: "Credential already in use" });
    const now = new Date().toISOString();
    await ctx.db.patch(args.id, { credentialHash: args.credentialHash, credentialIssuedAt: now,
      credentialRevokedAt: undefined, legacyDisabledAt: kiosk.legacyDisabledAt || now });
    await ctx.db.insert("auditLog", { actorUserId: actor.userId, action: kiosk.credentialIssuedAt ? "kiosk_credential_rotated" : "kiosk_credential_issued",
      targetTable: "kiosks", targetId: args.id, createdAt: now });
    return { kioskId: kiosk.kioskId || kiosk._id };
  },
});

export const revokeCredential = mutation({
  args: { id: v.id("kiosks"), confirmStopSync: v.boolean() },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args) => {
    const actor = await assertPortalRole(ctx, ["admin"]);
    const kiosk = await ctx.db.get(args.id);
    if (!kiosk?.active) throw new ConvexError({ code: "KIOSK_NOT_FOUND", message: "Active kiosk not found" });
    if (!args.confirmStopSync) throw new ConvexError({ code: "KIOSK_LOCKOUT_CONFIRMATION_REQUIRED", message: "Confirm that this kiosk will stop syncing before revoking access" });
    const now = new Date().toISOString();
    await ctx.db.patch(args.id, { credentialHash: undefined, credentialRevokedAt: now,
      legacyDisabledAt: kiosk.legacyDisabledAt || now });
    await ctx.db.insert("auditLog", { actorUserId: actor.userId, action: "kiosk_credential_revoked",
      targetTable: "kiosks", targetId: args.id, details: JSON.stringify({ legacyOnly: !kiosk.credentialHash && !kiosk.legacyDisabledAt }), createdAt: now });
    return { ok: true };
  },
});
