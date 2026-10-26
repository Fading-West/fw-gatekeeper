/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { ConvexError } from 'convex/values';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import schema from '../../../convex/schema';
import convex from '@/lib/convex';
import { api } from '../../../convex/_generated/api';
import { hasValidPortalSession } from '@/lib/portal-auth';
import { POST as correct } from './attendance-corrections/route';
import { POST as enroll } from './enroll/route';
import { POST as purge } from './workers/purge-biometrics/route';

vi.mock('@/lib/convex', () => ({ default: { mutation: vi.fn(), query: vi.fn(), action: vi.fn() } }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: vi.fn() }));
const modules = import.meta.glob('../../../convex/**/*.ts');
const date = '2026-09-14';

// A production Convex deployment returns only ConvexError data to clients.
// Every other thrown Error reaches the HTTP client as this redacted envelope.
function asProductionClientError(error: unknown) {
  return error instanceof ConvexError ? error : new Error('[Request ID: 0123456789abcdef] Server Error');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(hasValidPortalSession).mockResolvedValue(true);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async ctx => {
    const userId = await ctx.db.insert('users', { email: 'admin@example.test' });
    await ctx.db.insert('portalMembers', { userId, role: 'admin', active: true, createdAt: date });
    const workerId = await ctx.db.insert('workers', { name: 'Current Worker', employeeId: 'E-1', department: 'Assembly', active: true, enrolledAt: date });
    await ctx.db.insert('workers', { name: 'Former Worker', employeeId: 'E-2', department: 'Assembly', active: false, enrolledAt: date });
    const removedWorkerId = await ctx.db.insert('workers', { name: 'Removed Worker', department: '', active: false, enrolledAt: date });
    await ctx.db.delete(removedWorkerId);
    const attendanceId = await ctx.db.insert('attendance', { workerId, timestamp: `${date}T08:00:00`, eventType: 'clock_in', synced: true });
    return { userId, workerId, removedWorkerId, attendanceId };
  });
  const actor = t.withIdentity({ subject: ids.userId });
  // Match Convex HTTP serialization and production error redaction.
  const call = (run: (ref: any, args: any) => Promise<unknown>) => async (ref: any, args: unknown = {}) => {
    try {
      return await run(ref, JSON.parse(JSON.stringify(args)));
    } catch (error) {
      throw asProductionClientError(error);
    }
  };
  vi.mocked(convex.mutation).mockImplementation(call((ref, args) => actor.mutation(ref, args)) as any);
  vi.mocked(convex.query).mockImplementation(call((ref, args) => actor.query(ref, args)) as any);
  vi.mocked(convex.action).mockRejectedValue(new Error('photo storage is not part of this test'));
  return { t, ...ids };
}

function post(handler: (req: NextRequest) => Promise<Response>, path: string, body: unknown) {
  return handler(new NextRequest(`https://example.test/api/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
}

it('reports a second void of the same scan as a conflict in production', async () => {
  const { workerId, attendanceId } = await setup();
  const voidScan = (requestId: string) => post(correct, 'attendance-corrections', {
    date, worker_id: workerId, action: 'void_event', original_attendance_id: attendanceId, reason: 'Duplicate scan', request_id: requestId,
  });
  expect((await voidScan('void-one')).status).toBe(201);
  const response = await voidScan('void-two');
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: 'This attendance event already has an active void; reverse that correction before voiding it again',
  });
});

it('reports a reused correction request ID and a wrong-day void as client errors in production', async () => {
  const { workerId, attendanceId } = await setup();
  const add = { date, worker_id: workerId, action: 'add_clock_out', corrected_timestamp: `${date}T17:00:00`, reason: 'Missed scan', request_id: 'add-one' };
  expect((await post(correct, 'attendance-corrections', add)).status).toBe(201);
  const reused = await post(correct, 'attendance-corrections', { ...add, corrected_timestamp: `${date}T18:00:00` });
  expect(reused.status).toBe(409);
  expect(await reused.json()).toEqual({ error: 'Correction requestId was already used with different details.' });

  const wrongDay = await post(correct, 'attendance-corrections', {
    date: '2026-09-15', worker_id: workerId, action: 'void_event', original_attendance_id: attendanceId, reason: 'Wrong day', request_id: 'void-wrong-day',
  });
  expect(wrongDay.status).toBe(400);
  expect(await wrongDay.json()).toEqual({ error: 'Original attendance event is not on the correction date.' });
});

it('reports an employee ID owned by a former worker as a conflict in production', async () => {
  const { t, workerId } = await setup();
  vi.stubEnv('FACE_SERVICE_KEY', 'test');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ encoding: Array(512).fill(0.1), used_photo_indexes: [0, 1, 2] })));
  const response = await post(enroll, 'enroll', {
    workerId, name: 'Current Worker', employeeId: 'E-2', department: 'Assembly',
    expected_identity_revision: (await convex.query(api.workers.get, { id: workerId }))!.identity_revision,
    photos: Array(3).fill('data:image/jpeg;base64,YQ=='), consent: true, consentAgeMs: 0,
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: 'Employee ID E-2 already belongs to Former Worker' });
  expect((await t.run(ctx => ctx.db.get(workerId)))?.employeeId).toBe('E-1');
});

it('reports purging a missing worker as a client error in production', async () => {
  const { removedWorkerId } = await setup();
  const response = await post(purge, 'workers/purge-biometrics', { id: removedWorkerId, reason: 'Retention request' });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'Worker not found' });
});
