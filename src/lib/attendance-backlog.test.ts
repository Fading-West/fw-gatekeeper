import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { validateAttendanceEvent, type AttendanceEvent } from '../../convex/attendanceValidation';
import { ingestAttendanceBacklog } from './attendance-backlog';
import { getAttendanceReceiptStatus, ingestAttendanceBatch } from './convex-ingest';
vi.mock('./convex-ingest', () => ({ getAttendanceReceiptStatus: vi.fn(), ingestAttendanceBatch: vi.fn() }));
const receipts = new Set<string>();
const rows = new Set<string>();
const digest = (events: unknown[]) => createHash('sha256').update(JSON.stringify(events)).digest('hex');
const events = (size: number): AttendanceEvent[] => Array.from({ length: size }, (_, index) => validateAttendanceEvent({ workerId: 'worker', eventType: 'clock_in', timestamp: '2026-09-01 06:00:00', kioskId: 'entry', idempotencyKey: `row-${index}` }));
async function commit(chunk: unknown[], checkpoint?: boolean) {
  let synced = 0;
  for (const value of chunk as AttendanceEvent[]) if (!rows.has(value.idempotencyKey!)) { rows.add(value.idempotencyKey!); synced++; }
  if (checkpoint) receipts.add(digest(chunk));
  return { synced, acknowledged: chunk.length };
}
beforeEach(() => {
  vi.clearAllMocks(); receipts.clear(); rows.clear();
  vi.mocked(getAttendanceReceiptStatus).mockImplementation(async digests => ({ acknowledged: digests.map(value => receipts.has(value)) }));
  vi.mocked(ingestAttendanceBatch).mockImplementation(commit);
});
afterEach(() => vi.restoreAllMocks());
it.each([501, 1501])('accepts %i legacy events through bounded chunks with full acknowledgement', async size => {
  expect(await ingestAttendanceBacklog(events(size))).toEqual({ synced: size, acknowledged: size });
  expect(rows.size).toBe(size);
  expect(vi.mocked(ingestAttendanceBatch).mock.calls.map(call => call[0].length)).toEqual(size === 501 ? [500, 1] : [500, 500, 500, 1]);
});
it('retries only missing chunks after a partial failure without duplicates', async () => {
  vi.mocked(ingestAttendanceBatch).mockImplementationOnce(commit).mockRejectedValueOnce(new Error('network failed'));
  await expect(ingestAttendanceBacklog(events(1501))).rejects.toThrow('resume');
  expect(rows.size).toBe(1001);
  vi.mocked(ingestAttendanceBatch).mockClear();
  expect(await ingestAttendanceBacklog(events(1501))).toEqual({ synced: 500, acknowledged: 1501 });
  expect(ingestAttendanceBatch).toHaveBeenCalledTimes(1);
  expect(rows.size).toBe(1501);
});
it('resumes a lost acknowledgement from its committed receipt', async () => {
  vi.mocked(ingestAttendanceBatch).mockImplementationOnce(async (chunk, checkpoint) => { await commit(chunk, checkpoint); throw new Error('lost response'); });
  await expect(ingestAttendanceBacklog(events(501))).rejects.toThrow('resume');
  vi.mocked(ingestAttendanceBatch).mockClear();
  expect(await ingestAttendanceBacklog(events(501))).toEqual({ synced: 0, acknowledged: 501 });
  expect(ingestAttendanceBatch).not.toHaveBeenCalled();
});
it('rejects malformed trailing data before any network call', async () => {
  const payload = events(501); payload[500].timestamp = 'bad';
  await expect(ingestAttendanceBacklog(payload)).rejects.toThrow('timestamp');
  expect(ingestAttendanceBatch).not.toHaveBeenCalled();
  expect(getAttendanceReceiptStatus).not.toHaveBeenCalled();
});
it('stops starting work at the deadline and resumes committed progress next time', async () => {
  let now = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.mocked(ingestAttendanceBatch).mockImplementation(async (chunk, checkpoint) => { const result = await commit(chunk, checkpoint); now = 10_000; return result; });
  await expect(ingestAttendanceBacklog(events(2501))).rejects.toThrow('resume');
  expect(rows.size).toBe(2000);
  vi.mocked(ingestAttendanceBatch).mockImplementation(commit).mockClear();
  expect(await ingestAttendanceBacklog(events(2501))).toEqual({ synced: 501, acknowledged: 2501 });
  expect(ingestAttendanceBatch).toHaveBeenCalledTimes(2);
});
it('keeps stable full-chunk progress when new events append to a partial tail', async () => {
  await ingestAttendanceBacklog(events(501));
  vi.mocked(ingestAttendanceBatch).mockClear();
  expect(await ingestAttendanceBacklog(events(1001))).toEqual({ synced: 500, acknowledged: 1001 });
  expect(vi.mocked(ingestAttendanceBatch).mock.calls.map(call => call[0].length)).toEqual([500, 1]);
  expect(rows.size).toBe(1001);
});
it.each([{ synced: 1, acknowledged: 0 }, { synced: -1, acknowledged: 1 }, { synced: 1.5, acknowledged: 1 }, { synced: 2, acknowledged: 1 }])('rejects unsafe acknowledgements %j', async result => {
  vi.mocked(ingestAttendanceBatch).mockResolvedValueOnce(result);
  await expect(ingestAttendanceBacklog(events(1))).rejects.toThrow('acknowledgement');
});
it('rejects malformed receipt lookup results', async () => {
  vi.mocked(getAttendanceReceiptStatus).mockResolvedValueOnce({ acknowledged: [true] });
  await expect(ingestAttendanceBacklog(events(501))).rejects.toThrow('lookup');
  expect(ingestAttendanceBatch).not.toHaveBeenCalled();
});

it('acknowledges an empty queue without depending on upstream availability', async () => {
  expect(await ingestAttendanceBacklog([])).toEqual({ synced: 0, acknowledged: 0 });
  expect(ingestAttendanceBatch).not.toHaveBeenCalled();
  expect(getAttendanceReceiptStatus).not.toHaveBeenCalled();
});
