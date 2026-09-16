/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
const modules = import.meta.glob("./**/*.ts");
async function admin() {
  const t = convexTest(schema, modules);
  const id = await t.run(async ctx => {
    const userId = await ctx.db.insert("users", { email: "admin@example.com" });
    await ctx.db.insert("portalMembers", { userId, role: "admin", active: true, createdAt: new Date().toISOString() });
    return userId;
  });
  return t.withIdentity({ subject: id });
}
const valid = { name: "Day", days: "[1,2,3,4,5]", startTime: "06:00", endTime: "14:30" };
describe("same-day schedules", () => {
  it.each([["22:00", "06:00"], ["06:00", "06:00"], ["24:00", "25:00"], ["6:00", "14:30"], ["06:60", "14:30"]])("rejects %s–%s on create", async (startTime, endTime) => {
    const t = await admin();
    await expect(t.mutation(api.schedules.create, { ...valid, startTime, endTime })).rejects.toThrow("Overnight and 24-hour schedules are not supported");
    expect(await t.query(api.schedules.list, {})).toEqual([]);
  });
  it("validates merged partial updates atomically", async () => {
    const t = await admin();
    const { id } = await t.mutation(api.schedules.create, valid);
    await expect(t.mutation(api.schedules.update, { id, startTime: "15:00" })).rejects.toThrow("Overnight");
    await expect(t.mutation(api.schedules.update, { id, endTime: "05:00" })).rejects.toThrow("Overnight");
    expect(await t.query(api.schedules.list, {})).toMatchObject([{ start_time: "06:00", end_time: "14:30" }]);
    await t.mutation(api.schedules.update, { id, name: "Renamed", endTime: "15:00" });
  });
  it("allows repairing or removing legacy overnight schedules", async () => {
    const t = await admin();
    const id = await t.run(ctx => ctx.db.insert("schedules", { ...valid, startTime: "22:00", endTime: "06:00", active: true, createdAt: new Date().toISOString() }));
    await expect(t.mutation(api.schedules.update, { id, name: "Still invalid" })).rejects.toThrow("Overnight");
    await t.mutation(api.schedules.update, { id, startTime: "05:00" });
    expect(await t.query(api.schedules.list, {})).toMatchObject([{ start_time: "05:00", end_time: "06:00" }]);
    await t.mutation(api.schedules.remove, { id });
  });
});
