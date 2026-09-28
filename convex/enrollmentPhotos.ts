import { v } from "convex/values";
import { action, internalMutation, internalQuery, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { assertPortalRole } from "./access";

const EXPIRY_MS = 60 * 60 * 1000;

export const authorizeUpload = internalQuery({
  args: {},
  returns: v.id("users"),
  handler: async (ctx) => (await assertPortalRole(ctx, ["admin", "enrollment"])).userId,
});

// Only the server-side upload action can register a photo. Clients cannot claim
// somebody else's storage ID and subsequently delete it through cleanup.
export const register = internalMutation({
  args: { storageId: v.id("_storage"), ownerId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("pendingEnrollmentPhotos", { ...args, expiresAt: Date.now() + EXPIRY_MS });
    await ctx.scheduler.runAfter(EXPIRY_MS, internal.enrollmentPhotos.expire, { id });
    return null;
  },
});

export const upload = action({
  args: { photo: v.bytes() },
  returns: v.id("_storage"),
  handler: async (ctx, args): Promise<Id<"_storage">> => {
    const ownerId = await ctx.runQuery(internal.enrollmentPhotos.authorizeUpload, {});
    if (args.photo.byteLength === 0 || args.photo.byteLength > 3_000_000) throw new Error("Photo must contain 1 to 3000000 bytes");
    const storageId = await ctx.storage.store(new Blob([args.photo], { type: "image/jpeg" }));
    try {
      await ctx.runMutation(internal.enrollmentPhotos.register, { storageId, ownerId });
    } catch (error) {
      try {
        await ctx.storage.delete(storageId);
      } catch (cleanupError) {
        console.error("Failed to delete enrollment photo after registration failure", { storageId, cleanupError });
      }
      throw error;
    }
    return storageId;
  },
});

// Called in the same transaction that attaches the photos to a worker. Either
// both the attachment and receipt removal commit, or neither does.
export async function consumeEnrollmentPhotos(ctx: MutationCtx, ids: Id<"_storage">[] | undefined, ownerId: Id<"users">, existingIds?: Id<"_storage">[]) {
  const retained = new Set(existingIds ?? []);
  for (const storageId of new Set(ids ?? [])) {
    // Existence is not permission to attach a file: only a fresh upload or a
    // photo already on this worker may be used, including legacy attachments.
    if (!(await ctx.storage.getUrl(storageId))) throw new Error("Enrollment photo no longer exists; retry enrollment");
    const pending = await ctx.db.query("pendingEnrollmentPhotos").withIndex("by_storageId", (q) => q.eq("storageId", storageId)).unique();
    if (pending) {
      if (pending.ownerId !== ownerId) throw new Error("Enrollment photo belongs to another user");
      if (pending.expiresAt <= Date.now()) throw new Error("Enrollment photo expired; retry enrollment");
      await ctx.db.delete(pending._id);
    } else if (!retained.has(storageId)) {
      throw new Error("Enrollment photo is not an upload owned by you or already attached to this worker");
    }
  }
}

export const cleanup = mutation({
  args: { storageIds: v.array(v.id("_storage")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await assertPortalRole(ctx, ["admin", "enrollment"]);
    if (args.storageIds.length > 6) throw new Error("At most 6 enrollment photos may be cleaned up");
    for (const storageId of new Set(args.storageIds)) {
      const pending = await ctx.db.query("pendingEnrollmentPhotos").withIndex("by_storageId", (q) => q.eq("storageId", storageId)).unique();
      if (!pending) continue; // Already attached or not a tracked upload: never delete.
      if (pending.ownerId !== member.userId) throw new Error("Enrollment photo belongs to another user");
      await ctx.storage.delete(storageId);
      await ctx.db.delete(pending._id);
    }
    return null;
  },
});

export const expire = internalMutation({
  args: { id: v.id("pendingEnrollmentPhotos") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const pending = await ctx.db.get(args.id);
    if (!pending || pending.expiresAt > Date.now()) return null;
    await ctx.storage.delete(pending.storageId);
    await ctx.db.delete(pending._id);
    return null;
  },
});
