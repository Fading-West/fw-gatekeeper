/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const encoding = Array.from({ length: 512 }, () => 0.1);

async function authenticatedAdmin() {
  const test = convexTest(schema, modules);
  const adminId = await test.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "admin@example.com" });
    await ctx.db.insert("portalMembers", { userId, role: "admin", active: true, createdAt: new Date().toISOString() });
    return userId;
  });
  return test.withIdentity({ subject: adminId });
}

describe("worker identity safeguards", () => {
  it("normalizes employee IDs and rejects duplicates with different names", async () => {
    const admin = await authenticatedAdmin();
    await admin.mutation(api.workers.create, {
      name: "Alex Gonzalez",
      employeeId: "f-2",
      department: "Area Manager",
      faceEncoding: encoding,
      consentAt: new Date().toISOString(),
    });

    await expect(admin.mutation(api.workers.create, {
      name: "Alex Gonzales",
      employeeId: "F-2",
      department: "Area Manager",
      faceEncoding: encoding,
      consentAt: new Date().toISOString(),
    })).rejects.toThrow("Employee ID F-2 already belongs to Alex Gonzalez");
    await expect(admin.query(api.workers.findByEmployeeId, { employeeId: "f-2" })).resolves.toMatchObject({ name: "Alex Gonzalez", active: 1 });
  });

  it("rejects changing a worker to another active worker's employee ID", async () => {
    const admin = await authenticatedAdmin();
    await admin.mutation(api.workers.create, {
      name: "First Worker",
      employeeId: "F-1",
      department: "Operations",
      faceEncoding: encoding,
      consentAt: new Date().toISOString(),
    });
    const second = await admin.mutation(api.workers.create, {
      name: "Second Worker",
      employeeId: "F-2",
      department: "Operations",
      faceEncoding: encoding,
      consentAt: new Date().toISOString(),
    });

    await expect(admin.mutation(api.workers.update, { id: second.id, employeeId: "f-1" }))
      .rejects.toThrow("Employee ID F-1 already belongs to First Worker");
  });

  it("checks duplicate names beyond the first pagination window", async () => {
    const test = convexTest(schema, modules);
    const adminId = await test.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "admin@example.com" });
      await ctx.db.insert("portalMembers", { userId, role: "admin", active: true, createdAt: new Date().toISOString() });
      for (let index = 0; index < 501; index++) {
        await ctx.db.insert("workers", {
          name: index === 500 ? "Later Worker" : `Worker ${index}`,
          department: "Operations",
          enrolledAt: new Date().toISOString(),
          active: true,
        });
      }
      return userId;
    });
    const admin = test.withIdentity({ subject: adminId });

    await expect(admin.mutation(api.workers.create, {
      name: "later worker",
      employeeId: "F-999",
      department: "Operations",
      faceEncoding: encoding,
      consentAt: new Date().toISOString(),
    })).rejects.toThrow("Worker name already exists");
  });

  it("allows enrollment roles to create only canonical roster workers", async () => {
    const test = convexTest(schema, modules);
    const enrollmentId = await test.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "enrollment@example.com" });
      await ctx.db.insert("portalMembers", { userId, role: "enrollment", active: true, createdAt: new Date().toISOString() });
      return userId;
    });
    const enrollment = test.withIdentity({ subject: enrollmentId });

    await expect(enrollment.mutation(api.workers.create, {
      name: "Off Roster Person",
      employeeId: "OTHER-1",
      department: "Unknown",
      faceEncoding: encoding,
      consentAt: new Date().toISOString(),
    })).rejects.toThrow("Insufficient permissions");

    await expect(enrollment.mutation(api.workers.createFromRoster, {
      employeeId: "f-2",
      faceEncoding: encoding,
      consentAt: new Date().toISOString(),
    })).resolves.toMatchObject({
      name: "Alex Gonzalez",
      employeeId: "F-2",
      department: "Area Manager",
    });

    await expect(enrollment.mutation(api.workers.createFromRoster, {
      employeeId: "OTHER-1",
      faceEncoding: encoding,
      consentAt: new Date().toISOString(),
    })).rejects.toThrow("Employee must be selected from the company roster");
  });
});
