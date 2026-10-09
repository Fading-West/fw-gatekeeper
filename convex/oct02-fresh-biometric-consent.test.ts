/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';

const modules = import.meta.glob('./**/*.ts');
const now = '2026-10-08T15:00:00.000Z';
const acknowledgedAt = '2026-10-08T14:55:00.000Z';
const previousEnrollmentAt = '2026-10-01T15:00:00.000Z';
const faceEncoding = Array(512).fill(0.1);
const paths = ['create', 'roster create', 'reactivate', 'roster reactivate', 'template update', 'photo update'] as const;
type Path = typeof paths[number];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now));
});
afterEach(() => vi.useRealTimers());

async function setup(path: Path) {
  const t = convexTest(schema, modules);
  const { userId, workerId } = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'synthetic-admin@example.test' });
    await ctx.db.insert('portalMembers', { userId, role: 'admin', active: true, createdAt: now });
    const workerId = path === 'create' || path === 'roster create' ? null : await ctx.db.insert('workers', {
      name: 'Synthetic worker',
      employeeId: 'F-2',
      department: '',
      faceEncoding,
      active: path === 'template update' || path === 'photo update',
      enrolledAt: previousEnrollmentAt,
      updatedAt: previousEnrollmentAt,
      consentAt: previousEnrollmentAt,
      consentRecordedBy: userId,
    });
    return { userId, workerId };
  });
  return { t, admin: t.withIdentity({ subject: userId }), userId, workerId };
}

async function saveBiometrics(fixture: Awaited<ReturnType<typeof setup>>, path: Path, consentAt: string) {
  const { admin, workerId } = fixture;
  if (path === 'template update' || path === 'photo update') {
    await admin.mutation(api.workers.update, {
      id: workerId!, expectedIdentityRevision: (await admin.query(api.workers.get, { id: workerId! }))?.identity_revision,
      ...(path === 'template update' ? { faceEncoding } : { photoStorageIds: [] }),
      consentAt,
    });
    return workerId!;
  }
  if (path === 'roster create' || path === 'roster reactivate') {
    return (await admin.mutation(api.workers.createFromRoster, { employeeId: 'F-2', faceEncoding, consentAt })).id;
  }
  return (await admin.mutation(api.workers.create, {
    name: 'Synthetic worker', employeeId: 'F-2', faceEncoding, consentAt,
  })).id;
}

it.each(paths)('preserves the acknowledged timestamp in the worker and audit during %s', async path => {
  const fixture = await setup(path);
  const id = await saveBiometrics(fixture, path, acknowledgedAt);
  if (fixture.workerId) expect(id).toBe(fixture.workerId);

  await fixture.t.run(async ctx => {
    const worker = await ctx.db.get(id);
    expect.soft(worker).toMatchObject({
      active: true,
      consentAt: acknowledgedAt,
      consentRecordedBy: fixture.userId,
      enrolledAt: path === 'photo update' ? previousEnrollmentAt : now,
      updatedAt: now,
    });
    const audit = await ctx.db.query('auditLog')
      .withIndex('by_target', q => q.eq('targetTable', 'workers').eq('targetId', id))
      .collect();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'workers.enroll', actorUserId: fixture.userId, createdAt: now });
    expect.soft(JSON.parse(audit[0].details!)).toEqual({ consentAt: acknowledgedAt });
  });
});

it.each(paths)('rejects stale and future acknowledgements without changing workers or audit during %s', async path => {
  const fixture = await setup(path);
  const before = await fixture.t.run(ctx => ctx.db.query('workers').collect());
  for (const age of [11 * 60_000, -2 * 60_000]) {
    const consentAt = new Date(Date.now() - age).toISOString();
    await expect(saveBiometrics(fixture, path, consentAt)).rejects.toMatchObject({ data: { code: 'BIOMETRIC_CONSENT_STALE' } });
    await fixture.t.run(async ctx => {
      expect(await ctx.db.query('workers').collect()).toEqual(before);
      expect(await ctx.db.query('auditLog').collect()).toHaveLength(0);
    });
  }
});

it('preserves the acknowledgement when changing metadata without new biometrics', async () => {
  const { t, admin, workerId } = await setup('template update');
  await expect(admin.mutation(api.workers.update, { id: workerId!, expectedIdentityRevision: (await admin.query(api.workers.get, { id: workerId! }))?.identity_revision, department: 'New department' }))
    .resolves.toEqual({ ok: true });
  expect(await t.run(ctx => ctx.db.get(workerId!))).toMatchObject({ consentAt: previousEnrollmentAt });
});
