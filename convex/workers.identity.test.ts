/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api } from './_generated/api';
import schema from './schema';
import type { Id } from './_generated/dataModel';
const modules = import.meta.glob('./**/*.ts');
const faceEncoding = Array.from({ length: 512 }, () => 0.1);
const consentAt = '2026-09-01T12:00:00Z';

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async ctx => {
    const createdAt = new Date().toISOString();
    const admin = await ctx.db.insert('users', { email: 'admin@example.com' });
    const enrollment = await ctx.db.insert('users', { email: 'enrollment@example.com' });
    await ctx.db.insert('portalMembers', { userId: admin, active: true, role: 'admin', createdAt });
    await ctx.db.insert('portalMembers', { userId: enrollment, active: true, role: 'enrollment', createdAt });
    return { admin, enrollment };
  });
  return { t, admin: t.withIdentity({ subject: ids.admin }), enrollment: t.withIdentity({ subject: ids.enrollment }) };
}

describe('worker identity and enrollment permissions', () => {
  it('restores the same employee ID after a name change and keeps attendance attached', async () => {
    const { t, admin } = await setup();
    const first = await admin.mutation(api.workers.create, { name: 'Original Name', employeeId: 'F-77', faceEncoding, consentAt });
    await t.run(ctx => ctx.db.insert('attendance', { workerId: first.id, eventType: 'clock_in', timestamp: '2026-09-01T06:00:00', synced: true }));
    await admin.mutation(api.workers.remove, { id: first.id });
    const restored = await admin.mutation(api.workers.create, { name: 'Updated Name', employeeId: 'f-77', faceEncoding, consentAt });
    expect(restored.id).toBe(first.id);
    expect(await t.run(ctx => ctx.db.query('attendance').first())).toMatchObject({ workerId: restored.id });
  });

  it('does not attach an inactive namesake’s attendance to a different employee', async () => {
    const { t, admin } = await setup();
    const first = await admin.mutation(api.workers.create, { name: 'Same Name', employeeId: 'F-77', faceEncoding, consentAt });
    await admin.mutation(api.workers.remove, { id: first.id });
    const second = await admin.mutation(api.workers.create, { name: 'Same Name', employeeId: 'F-88', faceEncoding, consentAt });
    expect(second.id).not.toBe(first.id);
    expect(await t.run(ctx => ctx.db.get(first.id))).toMatchObject({ employeeId: 'F-77', active: false });
    // The old inactive namesake must not hide the active record in lookups.
    expect(await admin.query(api.workers.findByName, { name: '  Same   Name  ' })).toMatchObject({ id: second.id, active: 1 });
    await expect(admin.mutation(api.workers.create, { name: 'Same Name', employeeId: 'F-99', faceEncoding, consentAt })).rejects.toThrow('Worker name already exists');
  });

  it('blocks direct enrollment-role metadata rewrites but allows unchanged enrollment metadata', async () => {
    const { admin, enrollment } = await setup();
    const worker = await admin.mutation(api.workers.create, { name: 'Roster Person', employeeId: 'F-77', department: 'Operations', faceEncoding, consentAt });
    for (const change of [{ name: 'Off Roster Person' }, { employeeId: 'OTHER-1' }, { department: 'Leadership' }]) {
      await expect(enrollment.mutation(api.workers.update, { id: worker.id, ...change })).rejects.toThrow('Only admins');
    }
    await expect(enrollment.mutation(api.workers.update, { id: worker.id, name: ' Roster   Person ', employeeId: 'f-77', department: ' Operations ', faceEncoding, consentAt })).resolves.toEqual({ ok: true });
  });

  it('does not allow updates to retired identities or client-written enrollment timestamps', async () => {
    const { t, admin } = await setup();
    const worker = await admin.mutation(api.workers.create, { name: 'Worker', employeeId: 'F-77', faceEncoding, consentAt });
    await admin.mutation(api.workers.update, { id: worker.id, enrolledAt: 'forged' });
    expect((await t.run(ctx => ctx.db.get(worker.id as Id<"workers">)))!.enrolledAt).not.toBe('forged');
    await admin.mutation(api.workers.remove, { id: worker.id });
    await expect(admin.mutation(api.workers.update, { id: worker.id, name: 'Replacement Person' })).rejects.toThrow('Active worker not found');
  });
});
