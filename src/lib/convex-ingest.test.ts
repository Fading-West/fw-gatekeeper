import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ingestAttendanceBatch, ingestAttendanceEvent, updateKioskLastSync, acknowledgeRosterReceipt, SecuredIngestError } from './convex-ingest';
import { systemHealthCache, SYSTEM_HEALTH_CACHE_TTL_MS } from './system-health-cache';

beforeEach(() => {
  vi.stubEnv('CONVEX_INGEST_URL', 'https://example.convex.site');
  vi.stubEnv('CONVEX_INGEST_KEY', 'test-key');
  systemHealthCache.invalidate();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

it('keeps the Convex attendance validation code and reason across the secured ingest hop', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
    code: 'INVALID_ATTENDANCE',
    error: 'workerId must identify an existing worker',
  }, { status: 400 })));
  await expect(ingestAttendanceBatch([])).rejects.toMatchObject({
    status: 400,
    code: 'INVALID_ATTENDANCE',
    detail: 'workerId must identify an existing worker',
  } satisfies Partial<SecuredIngestError>);
});

it('does not invent a validation code for an unrelated upstream error', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'Bad Request' }, { status: 400 })));
  await expect(ingestAttendanceBatch([])).rejects.toMatchObject({ status: 400, code: undefined });
});

const healthWrites = [
  ['attendance event', () => ingestAttendanceEvent({ workerId: 'worker-1', eventType: 'check_in' }), { id: 'event-1' }],
  ['attendance batch', () => ingestAttendanceBatch([{}]), { synced: 1, acknowledged: 1 }],
  ['kiosk heartbeat', () => updateKioskLastSync('entry', '2026-10-09T12:00:00Z'), { updated: true }],
  ['roster acknowledgement', () => acknowledgeRosterReceipt('entry', 'receipt-1'), { acknowledged: true, appliedAt: '2026-10-09T12:00:00Z' }],
] as const;

function warmHealth() {
  for (const date of ['2026-10-08', '2026-10-09']) systemHealthCache.set(date, 'cached', systemHealthCache.generation);
}

it.each(healthWrites)('preserves the health TTL after a committed %s', async (_label, write, result) => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  warmHealth();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(result)));
  // A successful ingest shortly before expiry must neither clear nor renew it.
  vi.advanceTimersByTime(SYSTEM_HEALTH_CACHE_TTL_MS - 1);
  await write();
  for (const date of ['2026-10-08', '2026-10-09']) expect(systemHealthCache.get(date)).toBe('cached');
  vi.advanceTimersByTime(1);
  for (const date of ['2026-10-08', '2026-10-09']) expect(systemHealthCache.get(date)).toBeUndefined();
});

it.each(healthWrites)('keeps health cached after a rejected %s', async (_label, write) => {
  warmHealth();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'Unavailable' }, { status: 503 })));
  await expect(write()).rejects.toThrow();
  expect(systemHealthCache.get('2026-10-09')).toBe('cached');
});

it.each([
  [() => ingestAttendanceBatch([]), { synced: 0, acknowledged: 0 }],
  [() => updateKioskLastSync('missing', '2026-10-09T12:00:00Z'), { updated: false }],
  [() => acknowledgeRosterReceipt('entry', 'bad-receipt'), { acknowledged: false, appliedAt: null }],
] as const)('keeps health cached when an ingest call changes nothing', async (write, result) => {
  warmHealth();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(result)));
  await write();
  expect(systemHealthCache.get('2026-10-09')).toBe('cached');
});
