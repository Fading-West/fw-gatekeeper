import { NextRequest, NextResponse } from 'next/server';
import { ingestAttendanceBatch } from '@/lib/convex-ingest';
import { hasValidKioskKey, unauthorizedApiResponse } from '@/lib/auth';

export async function POST(req: NextRequest) {
  // Defense in depth: the middleware gates this route too, but the handler
  // must not depend on it. This is the only path to the server ingest key.
  if (!hasValidKioskKey(req)) {
    return unauthorizedApiResponse();
  }

  try {
    const body = await req.json();
    const events = body.events || body.logs;
    const bulkKioskId = body.kiosk_id;

    if (!Array.isArray(events)) {
      return NextResponse.json({ error: 'events (or logs) array required' }, { status: 400 });
    }

    const mapped = events.map((e: any) => ({
      workerId: e.worker_id,
      eventType: e.event_type || e.action,
      kioskId: e.kiosk_id || bulkKioskId || undefined,
      timestamp: e.timestamp,
      idempotencyKey: e.idempotency_key || e.idempotencyKey || e.id || undefined,
      workerName: e.worker_name || e.workerName || undefined,
      confidence: typeof e.confidence === 'number' ? e.confidence : undefined,
      livenessConfirmed:
        typeof e.liveness_confirmed === 'boolean'
          ? e.liveness_confirmed
          : e.liveness_confirmed === 1
            ? true
            : e.liveness_confirmed === 0
              ? false
              : undefined,
    }));

    const result = await ingestAttendanceBatch(mapped);
    console.info('next_secured_ingest_attendance', { received: mapped.length, synced: result.synced });
    return NextResponse.json(result);
  } catch (error) {
    console.error('Attendance bulk POST error:', error);
    return NextResponse.json({ error: 'Failed to record attendance batch' }, { status: 500 });
  }
}
