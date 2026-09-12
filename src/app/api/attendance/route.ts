export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import convex from '@/lib/convex';
import { api } from '../../../../convex/_generated/api';
import { ingestAttendanceEvent } from '@/lib/convex-ingest';
import { isValidLocalDateString, resolveRequestDate } from '@/lib/date';
import { hasValidKioskKey, unauthorizedApiResponse } from '@/lib/auth';

export async function GET(req: NextRequest) {
  try {
    const date = resolveRequestDate(req.nextUrl.searchParams);
    if (!isValidLocalDateString(date)) {
      return NextResponse.json({ error: 'date must use YYYY-MM-DD format' }, { status: 400 });
    }
    const workerId = req.nextUrl.searchParams.get('worker_id');
    const includeCorrections = req.nextUrl.searchParams.get('raw') === 'true' ? false : undefined;
    const rows = await convex.query(api.attendance.list, {
      date,
      workerId: workerId || undefined,
      includeCorrections,
    });
    return NextResponse.json(rows);
  } catch (error) {
    console.error('Attendance GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch attendance' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  // Defense in depth: kiosk credential is checked here, not only in middleware.
  if (!hasValidKioskKey(req)) {
    return unauthorizedApiResponse();
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { worker_id, event_type, type, kiosk_id, timestamp } = body;
    const resolvedType = event_type || type;

    if (!worker_id || !resolvedType) {
      return NextResponse.json({ error: 'worker_id and event_type (or type) required' }, { status: 400 });
    }

    const result = await ingestAttendanceEvent({
      workerId: worker_id,
      eventType: resolvedType,
      kioskId: kiosk_id || undefined,
      timestamp: timestamp || undefined,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    console.error('Attendance POST error:', error);
    return NextResponse.json({ error: 'Failed to record attendance' }, { status: 500 });
  }
}
