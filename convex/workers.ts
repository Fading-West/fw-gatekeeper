import { internalQuery, query, mutation } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { assertPortalRole } from "./access";
import { writeAuditLog } from "./audit";
import { findEmployeeDirectoryById } from "../src/lib/employee-directory";

// The kiosk matches exclusively 512-dim MobileFaceNet embeddings; legacy
// 128-dim dlib encodings are invalid and require re-enrollment.
const SUPPORTED_ENCODING_LENGTHS = new Set([512]);

function isSupportedFaceEncoding(encoding?: number[]) {
  return (
    encoding === undefined ||
    (SUPPORTED_ENCODING_LENGTHS.has(encoding.length) && encoding.every((value) => Number.isFinite(value)))
  );
}

function assertBiometricConsent(consentAt?: string) {
  if (!consentAt || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:?\d{2})$/i.test(consentAt) || !Number.isFinite(Date.parse(consentAt))) {
    throw new Error("Biometric consent must be confirmed before saving face data");
  }
}

async function deleteReplacedPhotos(ctx: MutationCtx, previous: Id<"_storage">[] | undefined, next: Id<"_storage">[] | undefined) {
  const retained = new Set(next ?? []);
  for (const id of new Set(previous ?? [])) {
    if (!retained.has(id)) await ctx.storage.delete(id);
  }
}

function assertPhotoLimit(photos?: Id<"_storage">[]) {
  if (photos && photos.length > 6) throw new Error("At most 6 enrollment photos may be stored");
}

function normalizeName(name: string) {
  return name.trim().replace(/\s+/g, " ");
}

function normalizeDepartment(department?: string) {
  return department?.trim() || "";
}

function normalizeEmployeeId(employeeId?: string) {
  return employeeId?.trim().toLocaleUpperCase() || undefined;
}

function getEncodingStatus(encoding?: number[]) {
  if (!encoding || encoding.length === 0) return "missing" as const;
  return isSupportedFaceEncoding(encoding) ? "valid" as const : "invalid" as const;
}

async function findWorkerByName(ctx: any, name: string) {
  const normalizedLower = normalizeName(name).toLocaleLowerCase();
  if (!normalizedLower) {
    return null;
  }
  let cursor: string | null = null;
  do {
    const page: any = await ctx.db.query("workers").paginate({ cursor, numItems: 500 });
    const worker = page.page.find((candidate: any) => candidate.name.trim().toLocaleLowerCase() === normalizedLower);
    if (worker) return worker;
    if (page.isDone) return null;
    cursor = page.continueCursor;
  } while (cursor);
  return null;
}

async function findWorkerByEmployeeId(ctx: any, employeeId?: string) {
  const normalized = normalizeEmployeeId(employeeId);
  if (!normalized) return null;
  const exact = await ctx.db
    .query("workers")
    .withIndex("by_employee_id_and_active", (q: any) => q.eq("employeeId", normalized).eq("active", true))
    .first();
  if (exact) return exact;

  // Compatibility for records created before IDs were normalized on write.
  let cursor: string | null = null;
  do {
    const page: any = await ctx.db
      .query("workers")
      .withIndex("by_active", (q: any) => q.eq("active", true))
      .paginate({ cursor, numItems: 500 });
    const worker = page.page.find((candidate: any) => normalizeEmployeeId(candidate.employeeId) === normalized);
    if (worker) return worker;
    if (page.isDone) return null;
    cursor = page.continueCursor;
  } while (cursor);
  return null;
}

export const list = query({
  args: { includeEncodings: v.optional(v.boolean()), active: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    await assertPortalRole(
      ctx,
      args.active === false ? ["admin"] : args.includeEncodings ? ["admin", "enrollment"] : ["admin", "enrollment", "viewer"],
    );
    const workers = await ctx.db
      .query("workers")
      .withIndex("by_active", (q) => q.eq("active", args.active ?? true))
      .collect();
    return workers.map((w) => {
      const encodingStatus = getEncodingStatus(w.faceEncoding);
      return {
        id: w._id,
        name: w.name,
        employee_id: w.employeeId || "",
        department: w.department,
        photo_url: null,
        ...(args.includeEncodings ? { face_encoding: w.faceEncoding || null } : {}),
        has_face_encoding: encodingStatus === "valid",
        encoding_status: encodingStatus,
        enrolled_at: w.enrolledAt,
        active: w.active ? 1 : 0,
      };
    });
  },
});

export const get = query({
  args: { id: v.id("workers") },
  handler: async (ctx, args) => {
    await assertPortalRole(ctx, ["admin", "enrollment"]);
    const w = await ctx.db.get(args.id);
    if (!w || !w.active) return null;
    return {
      id: w._id,
      name: w.name,
      employee_id: w.employeeId || "",
      department: w.department,
      photo_url: null,
      face_encoding: w.faceEncoding || null,
      has_face_encoding: getEncodingStatus(w.faceEncoding) === "valid",
      encoding_status: getEncodingStatus(w.faceEncoding),
      enrolled_at: w.enrolledAt,
      active: 1,
    };
  },
});

const createWorkerArgs = {
  name: v.string(),
  employeeId: v.optional(v.string()),
  department: v.optional(v.string()),
  faceEncoding: v.array(v.float64()),
  photoStorageIds: v.optional(v.array(v.id("_storage"))),
  // ISO timestamp of the biometric consent acknowledgement captured at enrollment.
  consentAt: v.optional(v.string()),
};

const createWorkerResult = v.object({
  id: v.id("workers"),
  name: v.string(),
  employeeId: v.optional(v.string()),
  department: v.string(),
});

async function createWorker(ctx: any, args: any, actorUserId: Id<"users">) {
    const name = normalizeName(args.name);
    if (!name) {
      throw new Error("Worker name is required");
    }
    if (!isSupportedFaceEncoding(args.faceEncoding)) {
      throw new Error("faceEncoding must contain 512 finite values");
    }
    assertBiometricConsent(args.consentAt);
    assertPhotoLimit(args.photoStorageIds);
    const now = new Date().toISOString();
    const employeeId = normalizeEmployeeId(args.employeeId);
    const department = normalizeDepartment(args.department);
    const existing = await findWorkerByName(ctx, name);
    const existingEmployeeId = await findWorkerByEmployeeId(ctx, employeeId);

    if (existing?.active) {
      throw new Error("Worker name already exists");
    }
    if (existingEmployeeId?.active && existingEmployeeId._id !== existing?._id) {
      throw new Error(`Employee ID ${employeeId} already belongs to ${existingEmployeeId.name}`);
    }

    if (existing && !existing.active) {
      await deleteReplacedPhotos(ctx, existing.photoStorageIds, args.photoStorageIds);
      await ctx.db.patch(existing._id, {
        name,
        employeeId,
        department,
        faceEncoding: args.faceEncoding,
        photoStorageIds: args.photoStorageIds,
        enrolledAt: now,
        updatedAt: now,
        active: true,
        consentAt: now,
        consentRecordedBy: actorUserId,
        // A fresh enrollment supersedes any earlier purge marker.
        biometricsPurgedAt: undefined,
      });
      await writeAuditLog(ctx, { actorUserId, action: "workers.enroll", targetTable: "workers", targetId: existing._id, details: JSON.stringify({ consentAt: now }) });
      return { id: existing._id, name, employeeId, department };
    }

    const id = await ctx.db.insert("workers", {
      name,
      employeeId,
      department,
      faceEncoding: args.faceEncoding,
      photoStorageIds: args.photoStorageIds,
      enrolledAt: now,
      updatedAt: now,
      active: true,
      consentAt: now,
      consentRecordedBy: actorUserId,
    });
    await writeAuditLog(ctx, { actorUserId, action: "workers.enroll", targetTable: "workers", targetId: id, details: JSON.stringify({ consentAt: now }) });
    return { id, name, employeeId, department };
}

export const create = mutation({
  args: createWorkerArgs,
  returns: createWorkerResult,
  handler: async (ctx, args) => {
    const member = await assertPortalRole(ctx, ["admin"]);
    return await createWorker(ctx, args, member.userId);
  },
});

export const createFromRoster = mutation({
  args: {
    employeeId: v.string(),
    faceEncoding: v.array(v.float64()),
    photoStorageIds: v.optional(v.array(v.id("_storage"))),
    consentAt: v.optional(v.string()),
  },
  returns: createWorkerResult,
  handler: async (ctx, args) => {
    const member = await assertPortalRole(ctx, ["admin", "enrollment"]);
    const employee = findEmployeeDirectoryById(args.employeeId);
    if (!employee) throw new Error("Employee must be selected from the company roster");
    return await createWorker(ctx, {
      name: employee.name,
      employeeId: employee.employeeId,
      department: employee.department,
      faceEncoding: args.faceEncoding,
      photoStorageIds: args.photoStorageIds,
      consentAt: args.consentAt,
    }, member.userId);
  },
});

export const findByName = query({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    await assertPortalRole(ctx, ["admin", "enrollment"]);
    const worker = await findWorkerByName(ctx, args.name);
    if (!worker) {
      return null;
    }
    return {
      id: worker._id,
      name: worker.name,
      active: worker.active ? 1 : 0,
    };
  },
});

export const findByEmployeeId = query({
  args: { employeeId: v.string() },
  returns: v.union(
    v.null(),
    v.object({ id: v.id("workers"), name: v.string(), active: v.number() }),
  ),
  handler: async (ctx, args) => {
    await assertPortalRole(ctx, ["admin", "enrollment"]);
    const worker = await findWorkerByEmployeeId(ctx, args.employeeId);
    if (!worker) return null;
    return { id: worker._id, name: worker.name, active: worker.active ? 1 : 0 };
  },
});

export const update = mutation({
  args: {
    id: v.id("workers"),
    name: v.optional(v.string()),
    employeeId: v.optional(v.string()),
    department: v.optional(v.string()),
    faceEncoding: v.optional(v.array(v.float64())),
    photoStorageIds: v.optional(v.array(v.id("_storage"))),
    enrolledAt: v.optional(v.string()),
    consentAt: v.optional(v.string()),
  },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args) => {
    const member = await assertPortalRole(ctx, ["admin", "enrollment"]);
    const { id, ...fields } = args;
    const worker = await ctx.db.get(id);
    if (!worker) throw new Error("Worker not found");
    const writesBiometrics = fields.faceEncoding !== undefined || fields.photoStorageIds !== undefined;
    if (writesBiometrics) assertBiometricConsent(fields.consentAt);
    assertPhotoLimit(fields.photoStorageIds);
    const updates: Record<string, unknown> = {};
    if (!isSupportedFaceEncoding(fields.faceEncoding)) {
      throw new Error("faceEncoding must contain 512 finite values");
    }
    if (fields.name !== undefined) {
      const trimmedName = normalizeName(fields.name);
      if (!trimmedName) {
        throw new Error("Worker name is required");
      }
      const existing = await findWorkerByName(ctx, trimmedName);
      if (existing && existing._id !== id && existing.active) {
        throw new Error("Worker name already exists");
      }
      updates.name = trimmedName;
    }
    if (fields.employeeId !== undefined) {
      const normalizedEmployeeId = normalizeEmployeeId(fields.employeeId);
      const existingEmployeeId = await findWorkerByEmployeeId(ctx, normalizedEmployeeId);
      if (existingEmployeeId && existingEmployeeId._id !== id && existingEmployeeId.active) {
        throw new Error(`Employee ID ${normalizedEmployeeId} already belongs to ${existingEmployeeId.name}`);
      }
      updates.employeeId = normalizedEmployeeId;
    }
    if (fields.department !== undefined) updates.department = normalizeDepartment(fields.department);
    if (fields.faceEncoding !== undefined) updates.faceEncoding = fields.faceEncoding;
    if (fields.photoStorageIds !== undefined) updates.photoStorageIds = fields.photoStorageIds;
    if (fields.enrolledAt !== undefined) updates.enrolledAt = fields.enrolledAt;
    if (writesBiometrics) {
      updates.consentAt = new Date().toISOString();
      updates.consentRecordedBy = member.userId;
      // An updated template supersedes its old enrollment photographs too.
      await deleteReplacedPhotos(ctx, worker.photoStorageIds, fields.photoStorageIds);
      updates.photoStorageIds = fields.photoStorageIds;
    }
    if (fields.faceEncoding !== undefined) {
      // Re-enrollment restores biometric data, so clear any earlier purge marker.
      updates.biometricsPurgedAt = undefined;
    }
    updates.updatedAt = new Date().toISOString();
    await ctx.db.patch(id, updates);
    if (writesBiometrics) await writeAuditLog(ctx, { actorUserId: member.userId, action: "workers.enroll", targetTable: "workers", targetId: id, details: JSON.stringify({ consentAt: updates.consentAt }) });
    return { ok: true };
  },
});

export const remove = mutation({
  args: { id: v.id("workers") },
  handler: async (ctx, args) => {
    const member = await assertPortalRole(ctx, ["admin"]);
    const worker = await ctx.db.get(args.id);
    if (!worker) throw new Error("Worker not found");
    await ctx.db.patch(args.id, { active: false, updatedAt: new Date().toISOString() });
    await writeAuditLog(ctx, {
      actorUserId: member.userId,
      action: "workers.remove",
      targetTable: "workers",
      targetId: args.id,
      details: JSON.stringify({ name: worker.name, employeeId: worker.employeeId ?? null }),
    });
    return { ok: true };
  },
});

/**
 * Permanently delete a worker's biometric data (face template + enrollment
 * photos). The worker is also deactivated: kiosks only drop a worker from
 * their local roster when the sync row says inactive, and `sync.py` skips
 * rows with a null face_encoding, so a purged-but-active worker would keep
 * matching at the door from the cached template. See RETENTION.md.
 */
export const purgeBiometrics = mutation({
  args: { id: v.id("workers"), reason: v.string() },
  returns: v.object({ ok: v.boolean(), photosDeleted: v.number(), purgedAt: v.string() }),
  handler: async (ctx, args) => {
    const member = await assertPortalRole(ctx, ["admin"]);
    const reason = args.reason.trim();
    if (!reason) {
      throw new Error("A reason is required to purge face data");
    }
    const worker = await ctx.db.get(args.id);
    if (!worker) throw new Error("Worker not found");

    let photosDeleted = 0;
    for (const storageId of new Set(worker.photoStorageIds ?? [])) {
      await ctx.storage.delete(storageId);
      photosDeleted += 1;
    }

    const now = new Date().toISOString();
    await ctx.db.patch(args.id, {
      faceEncoding: undefined,
      photoStorageIds: undefined,
      active: false,
      updatedAt: now,
      biometricsPurgedAt: now,
    });

    await writeAuditLog(ctx, {
      actorUserId: member.userId,
      action: "workers.purgeBiometrics",
      targetTable: "workers",
      targetId: args.id,
      reason,
      details: JSON.stringify({
        name: worker.name,
        employeeId: worker.employeeId ?? null,
        hadFaceEncoding: Boolean(worker.faceEncoding),
        photosDeleted,
        wasActive: worker.active,
      }),
    });

    return { ok: true, photosDeleted, purgedAt: now };
  },
});

const workerSyncResult = v.array(v.object({
  id: v.id("workers"),
  name: v.string(),
  employee_id: v.string(),
  department: v.string(),
  photo_url: v.union(v.string(), v.null()),
  face_encoding: v.union(v.array(v.float64()), v.null()),
  enrolled_at: v.string(),
  updated_at: v.string(),
  active: v.number(),
}));

async function listWorkersForSync(ctx: any, args: { since?: string }) {
  const all = await ctx.db.query("workers").collect();
  const since = args.since || "1970-01-01T00:00:00.000Z";
  const filtered = all.filter((w: any) => {
    const updatedAt = w.updatedAt || w.enrolledAt;
    return Boolean(updatedAt) && updatedAt > since;
  });
  const result = [];
  for (const w of filtered) {
    let photoUrls: string[] = [];
    if (w.photoStorageIds) {
      for (const sid of w.photoStorageIds) {
        const url = await ctx.storage.getUrl(sid);
        if (url) photoUrls.push(url);
      }
    }
    result.push({
      id: w._id,
      name: w.name,
      employee_id: w.employeeId || "",
      department: w.department,
      photo_url: photoUrls[0] || null,
      face_encoding: w.faceEncoding || null,
      enrolled_at: w.enrolledAt,
      updated_at: w.updatedAt || w.enrolledAt,
      active: w.active ? 1 : 0,
    });
  }
  return result;
}

export const listForSyncFromHttp = internalQuery({
  args: { since: v.optional(v.string()) },
  returns: workerSyncResult,
  handler: listWorkersForSync,
});

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await assertPortalRole(ctx, ["admin", "enrollment"]);
    return await ctx.storage.generateUploadUrl();
  },
});
