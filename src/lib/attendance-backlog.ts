import { createHash } from 'node:crypto';
import { MAX_ATTENDANCE_BATCH_SIZE, validateAttendanceEvent, type AttendanceEvent } from '../../convex/attendanceValidation';
import { getAttendanceReceiptStatus, ingestAttendanceBatch } from './convex-ingest';

export class AttendanceBacklogPendingError extends Error {}

function checkedAcknowledgement(result: { synced: number; acknowledged: number }, size: number) {
  if (!result || result.acknowledged !== size || !Number.isInteger(result.synced) || result.synced < 0 || result.synced > size) {
    throw new AttendanceBacklogPendingError('Attendance acknowledgement was incomplete');
  }
  return result;
}

// Old kiosks acknowledge their entire queue on HTTP 200. Durable chunk receipts
// let retries skip completed work while preserving that all-or-nothing response.
export async function ingestAttendanceBacklog(input: AttendanceEvent[]) {
  const events = input.map(validateAttendanceEvent);
  if (events.length === 0) return { synced: 0, acknowledged: 0 };
  if (events.length <= MAX_ATTENDANCE_BATCH_SIZE) {
    return checkedAcknowledgement(await ingestAttendanceBatch(events), events.length);
  }
  const deadline = Date.now() + 9_000;
  const chunks: AttendanceEvent[][] = [];
  for (let offset = 0; offset < events.length; offset += MAX_ATTENDANCE_BATCH_SIZE) chunks.push(events.slice(offset, offset + MAX_ATTENDANCE_BATCH_SIZE));
  const digests = chunks.map(chunk => createHash('sha256').update(JSON.stringify(chunk)).digest('hex'));
  const missing: number[] = [];
  for (let offset = 0; offset < digests.length; offset += 500) {
    if (Date.now() >= deadline) throw new AttendanceBacklogPendingError('Attendance upload will resume on retry');
    const group = digests.slice(offset, offset + 500);
    const result = await getAttendanceReceiptStatus(group);
    if (!result || !Array.isArray(result.acknowledged) || result.acknowledged.length !== group.length || result.acknowledged.some(value => typeof value !== 'boolean')) {
      throw new AttendanceBacklogPendingError('Attendance receipt lookup was incomplete');
    }
    result.acknowledged.forEach((complete, index) => { if (!complete) missing.push(offset + index); });
  }
  let synced = 0;
  for (let offset = 0; offset < missing.length; offset += 4) {
    if (Date.now() >= deadline) throw new AttendanceBacklogPendingError('Attendance upload will resume on retry');
    const results = await Promise.allSettled(missing.slice(offset, offset + 4).map(async index =>
      checkedAcknowledgement(await ingestAttendanceBatch(chunks[index], true), chunks[index].length)));
    if (results.some(result => result.status === 'rejected')) throw new AttendanceBacklogPendingError('Attendance upload will resume on retry');
    for (const result of results) if (result.status === 'fulfilled') synced += result.value.synced;
  }
  return { synced, acknowledged: events.length };
}
