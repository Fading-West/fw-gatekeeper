/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { internal } from './_generated/api';
import schema from './schema';
import { getFactoryLocalDateKey, getFactoryLocalTimestamp } from './localDate';
const modules = import.meta.glob('./**/*.ts');

async function setup() {
  const t = convexTest(schema, modules);
  const workerId = await t.run(ctx => ctx.db.insert('workers', { name: 'Worker', department: 'Operations', active: true, enrolledAt: '2026-09-01T12:00:00Z' }));
  const event = { workerId, eventType: 'clock_in', timestamp: '2026-09-01T06:00:00.123456', kioskId: 'entry-1', idempotencyKey: 'source-1', confidence: 0.9, livenessConfirmed: true };
  return { t, event };
}

afterEach(() => vi.unstubAllEnvs());
describe('attendance ingestion evidence integrity', () => {
  it('acknowledges retries without creating duplicate attendance', async () => {
    const { t, event } = await setup();
    expect(await t.mutation(internal.attendance.bulkCreateFromHttp, { events: [event, event] })).toEqual({ synced: 1, acknowledged: 2 });
    expect(await t.mutation(internal.attendance.bulkCreateFromHttp, { events: [event] })).toEqual({ synced: 0, acknowledged: 1 });
    expect(await t.run(ctx => ctx.db.query('attendance').collect())).toHaveLength(1);
  });

  it('rejects reused keys that change evidence and rolls back the entire batch', async () => {
    const { t, event } = await setup();
    await expect(t.mutation(internal.attendance.bulkCreateFromHttp, { events: [event, { ...event, eventType: 'clock_out' }] })).rejects.toThrow('idempotency key');
    expect(await t.run(ctx => ctx.db.query('attendance').collect())).toHaveLength(0);
  });

  it('scopes keys to the kiosk and preserves independently keyed events at identical times', async () => {
    const { t, event } = await setup();
    expect(await t.mutation(internal.attendance.bulkCreateFromHttp, { events: [event, { ...event, kioskId: 'exit-1', eventType: 'clock_out' }, { ...event, idempotencyKey: 'source-2' }] })).toEqual({ synced: 3, acknowledged: 3 });
  });

  it('does not collapse clock-in and clock-out evidence for legacy events at the same timestamp', async () => {
    const { t, event } = await setup();
    const legacy = { ...event, idempotencyKey: undefined };
    expect(await t.mutation(internal.attendance.bulkCreateFromHttp, { events: [legacy, { ...legacy, eventType: 'clock_out' }, legacy] })).toEqual({ synced: 2, acknowledged: 3 });
  });

  it('upgrades a legacy exact-event retry to its stable key', async () => {
    const { t, event } = await setup();
    await t.mutation(internal.attendance.bulkCreateFromHttp, { events: [{ ...event, idempotencyKey: undefined }] });
    expect(await t.mutation(internal.attendance.bulkCreateFromHttp, { events: [event] })).toEqual({ synced: 0, acknowledged: 1 });
    expect(await t.run(ctx => ctx.db.query('attendance').first())).toMatchObject({ idempotencyKey: event.idempotencyKey });
  });

  it.each(['2026-02-30T06:00:00', '2026-09-01', '2026-09-01garbage', '2026-09-01T25:00:00', '2026-09-01T06:60:00', '2026-09-01T06:00:00+99:00'])("rejects invalid timestamp %s before writing any event", async timestamp => {
    const { t, event } = await setup();
    await expect(t.mutation(internal.attendance.bulkCreateFromHttp, { events: [event, { ...event, idempotencyKey: 'bad', timestamp }] })).rejects.toThrow('timestamp');
    expect(await t.run(ctx => ctx.db.query('attendance').collect())).toHaveLength(0);
  });

  it('rejects wrong-table and missing worker IDs but retains deactivated workers’ queued scans', async () => {
    const { t, event } = await setup();
    const userId = await t.run(ctx => ctx.db.insert('users', { email: 'other@example.com' }));
    for (const workerId of [userId, 'not-a-worker']) await expect(t.mutation(internal.attendance.bulkCreateFromHttp, { events: [{ ...event, workerId }] })).rejects.toThrow('existing worker');
    await t.run(ctx => ctx.db.patch(event.workerId, { active: false }));
    expect(await t.mutation(internal.attendance.bulkCreateFromHttp, { events: [event] })).toEqual({ synced: 1, acknowledged: 1 });
  });

  it('rejects invalid event types, confidence, and oversized batches', async () => {
    const { t, event } = await setup();
    for (const confidence of [NaN, Infinity, -1, 2]) await expect(t.mutation(internal.attendance.bulkCreateFromHttp, { events: [{ ...event, confidence }] })).rejects.toThrow('confidence');
    await expect(t.mutation(internal.attendance.bulkCreateFromHttp, { events: [{ ...event, eventType: 'unknown' }] })).rejects.toThrow('eventType');
    await expect(t.mutation(internal.attendance.bulkCreateFromHttp, { events: Array.from({ length: 501 }, () => event) })).rejects.toThrow('at most 500');
  });

  it('single-event retries without a client timestamp keep the first server timestamp', async () => {
    const { t, event } = await setup();
    const single = { workerId: event.workerId, eventType: event.eventType, kioskId: event.kioskId, idempotencyKey: event.idempotencyKey };
    const first = await t.mutation(internal.attendance.createFromHttp, single);
    const retry = await t.mutation(internal.attendance.createFromHttp, single);
    expect(retry.id).toBe(first.id);
    expect(await t.run(ctx => ctx.db.query('attendance').collect())).toHaveLength(1);
  });

  it('returns explicit HTTP validation errors and acknowledgements behind the ingest credential', async () => {
    const { t, event } = await setup();
    vi.stubEnv('CONVEX_INGEST_KEY', 'test-ingest-key');
    const headers = { authorization: 'Bearer test-ingest-key', 'content-type': 'application/json' };
    expect((await t.fetch('/api/ingest/attendance/bulk', { method: 'POST', body: JSON.stringify({ events: [event] }) })).status).toBe(401);
    expect((await t.fetch('/api/ingest/attendance/bulk', { method: 'POST', headers, body: JSON.stringify({ events: [{ ...event, timestamp: 'bad' }] }) })).status).toBe(400);
    const valid = await t.fetch('/api/ingest/attendance/bulk', { method: 'POST', headers, body: JSON.stringify({ events: [event] }) });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ synced: 1, acknowledged: 1 });
  });
});


it("accepts legacy SQLite timestamps and harmless cosine rounding while preserving source spelling", async () => {
  const { t, event } = await setup();
  const legacy = { ...event, timestamp: "2026-09-01 06:00:00", confidence: 1.0000000000000002 };
  expect(await t.mutation(internal.attendance.bulkCreateFromHttp, { events: [legacy] })).toEqual({ synced: 1, acknowledged: 1 });
  expect(await t.mutation(internal.attendance.bulkCreateFromHttp, { events: [legacy] })).toEqual({ synced: 0, acknowledged: 1 });
  expect(await t.run(ctx => ctx.db.query("attendance").first())).toMatchObject({ timestamp: legacy.timestamp, confidence: 1 });
});


it("normalizes legacy spaces for daily views, including explicit UTC midnight rollover", () => {
  expect(getFactoryLocalTimestamp("2026-09-01 06:00:00")).toBe("2026-09-01T06:00:00");
  expect(getFactoryLocalDateKey("2026-09-02 01:00:00Z")).toBe("2026-09-01");
  expect(getFactoryLocalTimestamp("2026-09-02 01:00:00Z")).toBe("2026-09-01T20:00:00");
});
