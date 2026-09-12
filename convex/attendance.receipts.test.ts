/// <reference types="vite/client" />
import { createHash } from 'node:crypto';
import { convexTest } from 'convex-test';
import { afterEach, expect, it, vi } from 'vitest';
import schema from './schema';
import { internal } from './_generated/api';
import { validateAttendanceBatch } from './attendanceValidation';
const modules = import.meta.glob('./**/*.ts');
const headers = { authorization: 'Bearer receipt-test', 'content-type': 'application/json' };
afterEach(() => vi.unstubAllEnvs());
async function setup() {
  vi.stubEnv('CONVEX_INGEST_KEY', 'receipt-test');
  const t = convexTest(schema, modules);
  const workerId = await t.run(ctx => ctx.db.insert('workers', { name: 'Receipt worker', department: 'Operations', active: true, enrolledAt: '2026-09-01' }));
  const events = [{ workerId, eventType: 'clock_in', timestamp: '2026-09-01 06:00:00', kioskId: 'box-1', idempotencyKey: 'receipt-event' }];
  const digest = createHash('sha256').update(JSON.stringify(validateAttendanceBatch(events))).digest('hex');
  const upload = (payload: unknown) => t.fetch('/api/ingest/attendance/bulk', { method: 'POST', headers, body: JSON.stringify(payload) });
  return { t, events, digest, upload };
}
it('creates a canonical receipt atomically and resumes without reading a subsequently removed worker', async () => {
  const { t, events, digest, upload } = await setup();
  expect(await (await upload({ events, checkpoint: true })).json()).toEqual({ synced: 1, acknowledged: 1 });
  expect(await t.query(internal.attendance.receiptStatus, { digests: [digest, 'f'.repeat(64)] })).toEqual([true, false]);
  await t.run(ctx => ctx.db.delete(events[0].workerId));
  expect(await (await upload({ events, checkpoint: true })).json()).toEqual({ synced: 0, acknowledged: 1 });
  expect(await t.run(ctx => ctx.db.query('attendance').collect())).toHaveLength(1);
  expect(await t.run(ctx => ctx.db.query('attendanceIngestReceipts').collect())).toHaveLength(1);
});
it('rolls back events and the receipt when any event fails referential validation', async () => {
  const { t, events, upload } = await setup();
  const result = await upload({ events: [...events, { ...events[0], workerId: 'missing', idempotencyKey: 'different' }], checkpoint: true });
  expect(result.status).toBe(400);
  expect(await t.run(ctx => ctx.db.query('attendance').collect())).toHaveLength(0);
  expect(await t.run(ctx => ctx.db.query('attendanceIngestReceipts').collect())).toHaveLength(0);
});
it('does not let a changed payload reuse a receipt or accept a caller-supplied digest', async () => {
  const { t, events, digest, upload } = await setup();
  await upload({ events, checkpoint: true });
  const changed = [{ ...events[0], eventType: 'clock_out' }];
  expect((await upload({ events: changed, checkpoint: true, receiptHash: digest })).status).toBe(400);
  expect(await t.run(ctx => ctx.db.query('attendanceIngestReceipts').collect())).toHaveLength(1);
});
it('keeps receipts optional and validates checkpoint before writes', async () => {
  const { t, events, upload } = await setup();
  expect((await upload({ events, checkpoint: 'yes' })).status).toBe(400);
  expect(await t.run(ctx => ctx.db.query('attendance').collect())).toHaveLength(0);
  expect((await upload({ events })).status).toBe(200);
  expect(await t.run(ctx => ctx.db.query('attendanceIngestReceipts').collect())).toHaveLength(0);
});
it('authenticates receipt lookup and rejects malformed or unbounded hashes', async () => {
  const { t, digest } = await setup();
  const path = '/api/ingest/attendance/receipts';
  expect((await t.fetch(path, { method: 'POST', body: JSON.stringify({ digests: [digest] }) })).status).toBe(401);
  for (const digests of [null, ['bad'], ['F'.repeat(64)], Array(501).fill(digest)]) {
    expect((await t.fetch(path, { method: 'POST', headers, body: JSON.stringify({ digests }) })).status).toBe(400);
    if (digests !== null) await expect(t.query(internal.attendance.receiptStatus, { digests })).rejects.toThrow();
  }
  const response = await t.fetch(path, { method: 'POST', headers, body: JSON.stringify({ digests: [digest] }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ acknowledged: [false] });
});
