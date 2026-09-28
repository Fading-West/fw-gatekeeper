import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

const MAX_ACTIVE_KIOSKS = 1000;

export function createActiveKioskResolver(ctx: Pick<QueryCtx, "db">) {
  let fleet: Promise<Doc<"kiosks">[]> | undefined;
  const resolved = new Map<string, Promise<Doc<"kiosks"> | null>>();

  async function resolve(lookup: string) {
    // IDs are table-specific. A valid worker or schedule ID is not a kiosk.
    const kioskDocumentId = ctx.db.normalizeId("kiosks", lookup);
    if (kioskDocumentId) {
      const kiosk = await ctx.db.get(kioskDocumentId);
      if (kiosk?.active) return kiosk;
    }

    // Names and configured IDs share a case-insensitive alias namespace. Check
    // both together so legacy duplicates cannot silently route a heartbeat to
    // whichever row was inserted first. An incomplete fleet read is unsafe too.
    const kiosks = await (fleet ??= ctx.db
      .query("kiosks")
      .withIndex("by_active", (q) => q.eq("active", true))
      .take(MAX_ACTIVE_KIOSKS + 1));
    if (kiosks.length > MAX_ACTIVE_KIOSKS) return null;

    const normalizedLookup = lookup.toLowerCase();
    const matches = kiosks.filter(
      (kiosk) =>
        kiosk.name.trim().toLowerCase() === normalizedLookup ||
        (kiosk.kioskId || "").trim().toLowerCase() === normalizedLookup,
    );
    return matches.length === 1 ? matches[0] : null;
  }

  // Cache only within the caller's query/mutation, never across snapshots.
  return (identifier?: string | null): Promise<Doc<"kiosks"> | null> => {
    const lookup = identifier?.trim();
    if (!lookup) return Promise.resolve(null);
    let result = resolved.get(lookup);
    if (!result) {
      result = resolve(lookup);
      resolved.set(lookup, result);
    }
    return result;
  };
}

export async function findActiveKioskByIdentifier(
  ctx: Pick<QueryCtx, "db">,
  identifier?: string | null,
) {
  return createActiveKioskResolver(ctx)(identifier);
}
