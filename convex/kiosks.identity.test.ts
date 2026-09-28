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
    await ctx.db.insert("portalMembers", { userId, role: "admin", active: true, createdAt: "2026-09-15" });
    return userId;
  });
  return t.withIdentity({ subject: id });
}
const first = { name: "Front gate", kioskId: "entry-1", type: "entry" };
describe("kiosk registration identity", () => {
  it.each([
    { name: "Other", kioskId: "entry-1" },
    { name: "Other", kioskId: " ENTRY-1 " },
    { name: " FRONT GATE ", kioskId: "other" },
    { name: "Other", kioskId: " front GATE " },
    { name: " Entry-1 ", kioskId: "other" },
  ])("rejects aliases already owned by another active kiosk: %j", async aliases => {
    const t = await admin();
    await t.mutation(api.kiosks.create, first);
    await expect(t.mutation(api.kiosks.create, { ...first, ...aliases })).rejects.toThrow("already used");
    expect(await t.query(api.kiosks.list, {})).toHaveLength(1);
  });
  it("reserves existing document IDs in both alias fields", async () => {
    const t = await admin();
    const { id } = await t.mutation(api.kiosks.create, first);
    for (const aliases of [{ name: id, kioskId: "other" }, { name: "Other", kioskId: id }]) {
      await expect(t.mutation(api.kiosks.create, { ...first, ...aliases })).rejects.toThrow("already used");
    }
  });
  it("compares against trimmed legacy aliases", async () => {
    const t = await admin();
    await t.run(ctx => ctx.db.insert("kiosks", { ...first, name: " Front Gate ", kioskId: " ENTRY-1 ", location: "", active: true }));
    await expect(t.mutation(api.kiosks.create, { ...first, name: "Other" })).rejects.toThrow("already used");
  });
  it("allows unique names without sync IDs and matching aliases on the same kiosk", async () => {
    const t = await admin();
    await t.mutation(api.kiosks.create, { name: " Front ", type: "entry" });
    await t.mutation(api.kiosks.create, { name: "Back", kioskId: " BACK ", type: "exit" });
    expect(await t.query(api.kiosks.list, {})).toMatchObject([{ name: "Front", kiosk_id: null }, { name: "Back", kiosk_id: "BACK" }]);
  });
  it("allows reuse of inactive aliases and rejects empty names", async () => {
    const t = await admin();
    await t.run(ctx => ctx.db.insert("kiosks", { ...first, location: "", active: false }));
    await t.mutation(api.kiosks.create, first);
    await expect(t.mutation(api.kiosks.create, { name: "  ", type: "entry" })).rejects.toThrow("Kiosk name required");
  });
  it("fails closed at the supported active fleet limit", async () => {
    const t = await admin();
    await t.run(async ctx => {
      for (let i = 0; i < 999; i++) await ctx.db.insert("kiosks", { name: `Gate ${i}`, type: "entry", location: "", active: true });
    });
    await t.mutation(api.kiosks.create, first);
    await expect(t.mutation(api.kiosks.create, { name: "Extra", type: "entry" })).rejects.toThrow("1,000 active kiosks");
  });
});
