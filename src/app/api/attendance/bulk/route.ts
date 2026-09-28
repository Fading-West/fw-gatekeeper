import { NextRequest, NextResponse } from 'next/server';
import { AttendanceBacklogPendingError, ingestAttendanceBacklog } from '@/lib/attendance-backlog';
import { unauthorizedApiResponse } from '@/lib/auth';
import { authenticateKiosk, kioskClaims, kioskEvidenceId } from '@/lib/kiosk-device-auth';
import { ConvexError } from 'convex/values';
import { SecuredIngestError } from '@/lib/convex-ingest';
import { validateAttendanceEvent } from '../../../../../convex/attendanceValidation';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'A JSON object is required' }, { status: 400 });
    }
    const events = body.events || body.logs;

    if (!Array.isArray(events)) {
      return NextResponse.json({ error: 'events (or logs) array required' }, { status: 400 });
    }
    const claims = [...kioskClaims(body), ...events.flatMap((event: unknown) =>
      event && typeof event === 'object' && !Array.isArray(event) ? kioskClaims(event as Record<string, unknown>) : [])];
    const identity = await authenticateKiosk(req, claims);
    if (!identity) return unauthorizedApiResponse();

    const mapped = events.map((value: unknown) => {
      const e = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
      return validateAttendanceEvent({
        workerId: e.worker_id,
        eventType: e.event_type || e.action,
        kioskId: kioskEvidenceId(identity, e, body),
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
    if (error instanceof ConvexError) return NextResponse.json({ error: error.data.message, code: error.data.code }, { status: 400 });
    if (error instanceof SecuredIngestError && error.status === 400 && error.code === 'INVALID_ATTENDANCE') {
      return NextResponse.json({ error: error.detail || 'Invalid attendance', code: error.code }, { status: 400 });
    }
    if (error instanceof AttendanceBacklogPendingError) return NextResponse.json({ error: error.message }, { status: 503 });
    console.error('Attendance bulk POST error:', error);
    return NextResponse.json({ error: 'Failed to record attendance batch' }, { status: 500 });
  }
}
