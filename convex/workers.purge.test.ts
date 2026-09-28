/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const encoding = Array.from({ length: 512 }, () => 0.1);

type Role = "admin" | "enrollment" | "viewer";

async function setup(role: Role) {
  const test = convexTest(schema, modules);
  const { userId, workerId, storageIds } = await test.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: `${role}@example.com` });
    await ctx.db.insert("portalMembers", { userId, role, active: true, createdAt: new Date().toISOString() });
    const storageIds = [
      await ctx.storage.store(new Blob(["photo-1"], { type: "image/jpeg" })),
      await ctx.storage.store(new Blob(["photo-2"], { type: "image/jpeg" })),
    ];
    const workerId = await ctx.db.insert("workers", {
      name: "Purge Target",
      employeeId: "F-77",
      department: "Operations",
      faceEncoding: encoding,
      photoStorageIds: storageIds,
      enrolledAt: new Date().toISOString(),
      consentAt: new Date().toISOString(),
      active: true,
    });
    return { userId, workerId, storageIds };
  });
  return { test, actor: test.withIdentity({ subject: userId }), userId, workerId, storageIds };
}

describe("workers.purgeBiometrics", () => {
  it("removes the template and photos, deactivates the worker, and writes an audit row", async () => {
    const { test, actor, userId, workerId, storageIds } = await setup("admin");

    await test.run(async (ctx) => {
      for (const id of storageIds) {
        expect(await ctx.storage.getUrl(id)).not.toBeNull();
      }
    });

    await expect(actor.mutation(api.workers.purgeBiometrics, { id: workerId, reason: "  Terminated  " }))
      .resolves.toMatchObject({ ok: true });

    await test.run(async (ctx) => {
      const worker = await ctx.db.get(workerId);
      expect(worker).not.toBeNull();
      expect(worker!.faceEncoding).toBeUndefined();
      expect(worker!.photoStorageIds).toBeUndefined();
      expect(worker!.active).toBe(false);
      expect(typeof worker!.biometricsPurgedAt).toBe("string");
      expect(worker!.updatedAt).toBe(worker!.biometricsPurgedAt);
      // Non-biometric identity metadata is retained for attendance history.
      expect(worker!.name).toBe("Purge Target");

      for (const id of storageIds) {
        expect(await ctx.storage.getUrl(id)).toBeNull();
      }

      const audit = await ctx.db
        .query("auditLog")
        .withIndex("by_target", (q) => q.eq("targetTable", "workers").eq("targetId", workerId))
        .collect();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actorUserId: userId,
        action: "workers.purgeBiometrics",
        reason: "Terminated",
      });
      expect(audit[0].details).toContain("photosDeleted");
    });
  });

  it("drops the worker from the kiosk sync feed as inactive so cached templates are removed", async () => {
    const { test, actor, workerId } = await setup("admin");
    await actor.mutation(api.workers.purgeBiometrics, { id: workerId, reason: "Worker requested deletion" });

    const rows = await test.run(async (ctx) => {
      const worker = await ctx.db.get(workerId);
      return { active: worker!.active, faceEncoding: worker!.faceEncoding ?? null };
    });
    expect(rows.active).toBe(false);
    expect(rows.faceEncoding).toBeNull();
  });

  it("rejects an empty or whitespace-only reason", async () => {
    const { actor, workerId } = await setup("admin");
    await expect(actor.mutation(api.workers.purgeBiometrics, { id: workerId, reason: "" }))
      .rejects.toThrow("A reason is required to purge face data");
    await expect(actor.mutation(api.workers.purgeBiometrics, { id: workerId, reason: "   " }))
      .rejects.toThrow("A reason is required to purge face data");
  });

  it("rejects enrollment and viewer roles", async () => {
    for (const role of ["enrollment", "viewer"] as const) {
      const { test, actor, workerId, storageIds } = await setup(role);
      await expect(actor.mutation(api.workers.purgeBiometrics, { id: workerId, reason: "Not allowed" }))
        .rejects.toThrow("Insufficient permissions");
      await test.run(async (ctx) => {
        const worker = await ctx.db.get(workerId);
        expect(worker!.faceEncoding).toEqual(encoding);
        expect(worker!.active).toBe(true);
        for (const id of storageIds) {
          expect(await ctx.storage.getUrl(id)).not.toBeNull();
        }
      });
    }
  });

  it("records an audit row when a worker is deactivated", async () => {
    const { test, actor, userId, workerId } = await setup("admin");
    await actor.mutation(api.workers.remove, { id: workerId });
    await test.run(async (ctx) => {
      const audit = await ctx.db
        .query("auditLog")
        .withIndex("by_target", (q) => q.eq("targetTable", "workers").eq("targetId", workerId))
        .collect();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorUserId: userId, action: "workers.remove" });
      // Deactivation alone keeps the template; only purge deletes it.
      const worker = await ctx.db.get(workerId);
      expect(worker!.faceEncoding).toEqual(encoding);
    });
  });

  it("records the server consent receipt and authenticated operator on every enrollment", async () => {
    const { actor, test, userId } = await setup("admin");
    const created = await actor.mutation(api.workers.create, {
      name: "Consent Worker",
      employeeId: "F-88",
      department: "Operations",
      faceEncoding: encoding,
      consentAt: "2026-01-01T00:00:00.000Z",
    });
    const createdId = created.id as Id<"workers">;
    await test.run(async (ctx) => {
      expect((await ctx.db.get(createdId))!.consentAt).not.toBe("2026-01-01T00:00:00.000Z");
      expect((await ctx.db.get(createdId))!.consentRecordedBy).toBe(userId);
    });
    await actor.mutation(api.workers.update, { id: createdId, faceEncoding: encoding, consentAt: "2026-02-01T00:00:00.000Z" });
    await test.run(async (ctx) => {
      expect((await ctx.db.get(createdId))!.consentAt).not.toBe("2026-02-01T00:00:00.000Z");
      expect((await ctx.db.get(createdId))!.consentRecordedBy).toBe(userId);
    });
  });
});


describe("biometric write consent and replacement", () => {
  it("requires consent at the database boundary, including direct roster/update calls", async () => {
    const { actor, workerId } = await setup("admin");
    await expect(actor.mutation(api.workers.create, { name: "No Consent", faceEncoding: encoding })).rejects.toThrow("Biometric consent");
    await expect(actor.mutation(api.workers.createFromRoster, { employeeId: "F-2", faceEncoding: encoding })).rejects.toThrow("Biometric consent");
    await expect(actor.mutation(api.workers.update, { id: workerId, faceEncoding: encoding })).rejects.toThrow("Biometric consent");
    await expect(actor.mutation(api.workers.update, { id: workerId, photoStorageIds: [] })).rejects.toThrow("Biometric consent");
    await expect(actor.mutation(api.workers.update, { id: workerId, faceEncoding: encoding, consentAt: "invalid" })).rejects.toThrow("Biometric consent");
  });

  it("deletes superseded photos while retaining photos still referenced by the replacement", async () => {
    const { actor, test, workerId, storageIds } = await setup("admin");
    await actor.mutation(api.workers.update, { id: workerId, faceEncoding: encoding, photoStorageIds: [storageIds[0]], consentAt: new Date().toISOString() });
    await test.run(async (ctx) => {
      expect(await ctx.storage.getUrl(storageIds[0])).not.toBeNull();
      expect(await ctx.storage.getUrl(storageIds[1])).toBeNull();
    });
    await actor.mutation(api.workers.update, { id: workerId, faceEncoding: encoding, consentAt: new Date().toISOString() });
    await test.run(async (ctx) => {
      expect(await ctx.storage.getUrl(storageIds[0])).toBeNull();
      expect((await ctx.db.get(workerId))!.photoStorageIds).toBeUndefined();
    });
  });

  it("preserves consent and photos when changing metadata only", async () => {
    const { actor, test, workerId, storageIds } = await setup("admin");
    await actor.mutation(api.workers.update, { id: workerId, department: "New", consentAt: "forged" });
    await test.run(async (ctx) => {
      expect((await ctx.db.get(workerId))!.consentAt).not.toBe("forged");
      for (const id of storageIds) expect(await ctx.storage.getUrl(id)).not.toBeNull();
    });
  });
});


it("lets admins find inactive workers for purge without exposing the archive to other roles", async () => {
  const { actor, workerId } = await setup("admin");
  await actor.mutation(api.workers.remove, { id: workerId });
  expect(await actor.query(api.workers.list, {})).toHaveLength(0);
  expect(await actor.query(api.workers.list, { active: false })).toMatchObject([{ id: workerId, active: 0 }]);
  await actor.mutation(api.workers.purgeBiometrics, { id: workerId, reason: "Archived deletion request" });
  expect(await actor.query(api.workers.list, { active: false })).toMatchObject([{ id: workerId, has_face_encoding: false }]);
  for (const role of ["enrollment", "viewer"] as const) {
    const { actor: other } = await setup(role);
    await expect(other.query(api.workers.list, { active: false })).rejects.toThrow("Insufficient permissions");
  }
});


it("accepts up to six quality-approved photos and rejects larger sets", async () => {
  const { actor, workerId } = await setup("admin");
  const photos = [];
  for (let i = 0; i < 7; i++) photos.push(await actor.action(api.enrollmentPhotos.upload, { photo: new TextEncoder().encode(String(i)).buffer }));
  await expect(actor.mutation(api.workers.update, { id: workerId, faceEncoding: encoding, photoStorageIds: photos.slice(0, 6), consentAt: new Date().toISOString() })).resolves.toEqual({ ok: true });
  await expect(actor.mutation(api.workers.update, { id: workerId, faceEncoding: encoding, photoStorageIds: photos, consentAt: new Date().toISOString() })).rejects.toThrow("At most 6");
});
