import { NextRequest, NextResponse } from 'next/server';
import { AttendanceBacklogPendingError, ingestAttendanceBacklog } from '@/lib/attendance-backlog';
import { hasValidKioskKey, unauthorizedApiResponse } from '@/lib/auth';
import { ConvexError } from 'convex/values';
import { validateAttendanceEvent } from '../../../../../convex/attendanceValidation';

export async function POST(req: NextRequest) {
  // Defense in depth: the middleware gates this route too, but the handler
  // must not depend on it. This is the only path to the server ingest key.
  if (!hasValidKioskKey(req)) {
    return unauthorizedApiResponse();
  }

  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'A JSON object is required' }, { status: 400 });
    }
    const events = body.events || body.logs;
    const bulkKioskId = body.kiosk_id;

    if (!Array.isArray(events)) {
      return NextResponse.json({ error: 'events (or logs) array required' }, { status: 400 });
    }

    const mapped = events.map((value: unknown) => {
      const e = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
      return validateAttendanceEvent({
        workerId: e.worker_id,
        eventType: e.event_type || e.action,
        kioskId: e.kiosk_id || bulkKioskId || undefined,
        timestamp: e.timestamp,
        idempotencyKey: e.idempotency_key || e.idempotencyKey || e.id || undefined,
        workerName: e.worker_name || e.workerName || undefined,
        confidence: e.confidence,
        note: e.note,
        livenessConfirmed:
          typeof e.liveness_confirmed === 'boolean'
            ? e.liveness_confirmed
            : e.liveness_confirmed === 1
              ? true
              : e.liveness_confirmed === 0
                ? false
                : e.liveness_confirmed,
      });
    });

    const result = await ingestAttendanceBacklog(mapped);
    console.info('next_secured_ingest_attendance', { received: mapped.length, synced: result.synced });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ConvexError) return NextResponse.json({ error: error.data.message }, { status: 400 });
    if (error instanceof AttendanceBacklogPendingError) return NextResponse.json({ error: error.message }, { status: 503 });
    console.error('Attendance bulk POST error:', error);
    return NextResponse.json({ error: 'Failed to record attendance batch' }, { status: 500 });
  }
}
