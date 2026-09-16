/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { expect, it, vi, afterEach } from 'vitest';
import { api, internal } from './_generated/api';
import schema from './schema';
const modules = import.meta.glob('./**/*.ts');
afterEach(() => vi.unstubAllEnvs());
async function setup() {
  const t = convexTest(schema, modules);
  const { workerId, userId } = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { name: 'Reviewer' });
    await ctx.db.insert('portalMembers', { userId, role: 'admin', active: true, createdAt: '2026-09-01' });
    const workerId = await ctx.db.insert('workers', { name: 'Worker', department: 'Operations', active: true, enrolledAt: '2026-09-01' });
    return { workerId, userId };
  });
  return { t, admin: t.withIdentity({ subject: userId }), event: { workerId, eventType: 'clock_in', timestamp: '2026-09-01T08:00:00', kioskId: 'entry', idempotencyKey: 'manual-1', note: 'manual_clock' } };
}
it.each(['/api/ingest/attendance', '/api/ingest/attendance/bulk'])('preserves manual provenance through %s and raw/effective history', async path => {
  const { t, admin, event } = await setup();
  vi.stubEnv('CONVEX_INGEST_KEY', 'test-ingest-key');
  const response = await t.fetch(path, { method: 'POST', headers: { authorization: 'Bearer test-ingest-key', 'content-type': 'application/json' }, body: JSON.stringify(path.endsWith('/bulk') ? { events: [event] } : event) });
  expect(response.status).toBe(path.endsWith('/bulk') ? 200 : 201);
  expect(await t.run(ctx => ctx.db.query('attendance').first())).toMatchObject({ note: 'manual_clock' });
  for (const includeCorrections of [true, false]) {
    expect(await admin.query(api.attendance.list, { date: '2026-09-01', includeCorrections })).toMatchObject([{ note: 'manual_clock', source: 'kiosk' }]);
  }
});
it('preserves legacy records and restores a dropped note on retry without duplicating attendance', async () => {
  const { t, admin, event } = await setup();
  const legacy = { ...event, note: undefined };
  await t.mutation(internal.attendance.bulkCreateFromHttp, { events: [legacy] });
  expect(await admin.query(api.attendance.list, { date: '2026-09-01' })).toMatchObject([{ note: null }]);
  expect(await t.mutation(internal.attendance.bulkCreateFromHttp, { events: [event] })).toEqual({ synced: 0, acknowledged: 1 });
  await t.mutation(internal.attendance.bulkCreateFromHttp, { events: [legacy, event] });
  expect(await t.run(ctx => ctx.db.query('attendance').collect())).toMatchObject([{ note: 'manual_clock' }]);
  await expect(t.mutation(internal.attendance.bulkCreateFromHttp, { events: [{ ...event, note: 'different evidence' }] })).rejects.toThrow('cannot change');
});
it('preserves provenance when upgrading an unkeyed legacy retry', async () => {
  const { t, event } = await setup();
  await t.mutation(internal.attendance.bulkCreateFromHttp, { events: [{ ...event, note: undefined, idempotencyKey: undefined }] });
  await t.mutation(internal.attendance.bulkCreateFromHttp, { events: [event] });
  expect(await t.run(ctx => ctx.db.query('attendance').collect())).toMatchObject([{ note: 'manual_clock', idempotencyKey: event.idempotencyKey }]);
});
