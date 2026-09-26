export const dynamic = 'force-dynamic';

import { ConvexError } from 'convex/values';
import { NextRequest, NextResponse } from 'next/server';
import convex from '@/lib/convex';
import { unauthorizedApiResponse } from '@/lib/auth';
import { hasValidPortalSession } from '@/lib/portal-auth';
import { api } from '../../../../convex/_generated/api';
import { isValidLocalDateString, resolveRequestDate } from '@/lib/date';

const VALID_ACTIONS = new Set(['add_clock_in', 'add_clock_out', 'void_event']);

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getDate(req: NextRequest) {
  const date = resolveRequestDate(req.nextUrl.searchParams);
  return isValidLocalDateString(date) ? date : null;
}

function isMissingConvexFunction(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('FunctionPathNotFound') || message.includes('Could not find public function');
}

export async function GET(req: NextRequest) {
  if (!(await hasValidPortalSession(req, ['admin', 'enrollment', 'viewer']))) {
    return unauthorizedApiResponse();
  }

  const date = getDate(req);
  if (!date) {
    return NextResponse.json({ error: 'date must use YYYY-MM-DD format' }, { status: 400 });
  }
  try {
    const workerId = req.nextUrl.searchParams.get('worker_id') || undefined;
    const corrections = await convex.query((api as any).attendanceCorrections.list, { date, workerId });
    return NextResponse.json({
      date,
      corrections,
    });
  } catch (error) {
    if (isMissingConvexFunction(error)) {
      return NextResponse.json({
        date,
        corrections: [],
        backend_unavailable: true,
        warning: 'Attendance correction storage is waiting for the Convex functions to deploy.',
      });
    }
    console.error('Attendance corrections GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch attendance corrections' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!(await hasValidPortalSession(req, ['admin', 'enrollment']))) {
    return unauthorizedApiResponse();
  }

  try {
    const body = await req.json().catch(() => ({}));
    const requestId = body.request_id ?? body.requestId;
    if (requestId !== undefined && (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 200)) {
      return NextResponse.json({ error: 'request_id must be a nonempty string of at most 200 characters' }, { status: 400 });
    }
    const date = optionalString(body.date);
    const workerId = optionalString(body.worker_id) || optionalString(body.workerId);
    const action = optionalString(body.action);
    const correctedTimestamp = optionalString(body.corrected_timestamp) || optionalString(body.correctedTimestamp);
    const originalAttendanceId = optionalString(body.original_attendance_id) || optionalString(body.originalAttendanceId);
    const relatedExceptionKey = optionalString(body.related_exception_key) || optionalString(body.relatedExceptionKey);
    const reason = optionalString(body.reason);
    const supervisorName = optionalString(body.supervisor_name) || optionalString(body.supervisorName);

    if (!date || !isValidLocalDateString(date)) {
      return NextResponse.json({ error: 'date must use YYYY-MM-DD format' }, { status: 400 });
    }
    if (!workerId || !action || !reason) {
      return NextResponse.json({ error: 'worker_id, action, and reason required' }, { status: 400 });
    }
    if (!VALID_ACTIONS.has(action)) {
      return NextResponse.json({ error: 'action must be add_clock_in, add_clock_out, or void_event' }, { status: 400 });
    }
    if (action === 'void_event' && !originalAttendanceId) {
      return NextResponse.json({ error: 'original_attendance_id required for void_event' }, { status: 400 });
    }
    if (action !== 'void_event' && !correctedTimestamp) {
      return NextResponse.json({ error: 'corrected_timestamp required for added events' }, { status: 400 });
    }

    const result = await convex.mutation((api as any).attendanceCorrections.create, {
      requestId,
      date,
      workerId,
      action,
      correctedTimestamp,
      originalAttendanceId,
      relatedExceptionKey,
      reason,
      supervisorName,
    });

    return NextResponse.json(result || { ok: true }, { status: 201 });
  } catch (error) {
    if (error instanceof ConvexError && error.data?.code === 'INVALID_CORRECTION_TIMESTAMP') {
      return NextResponse.json({ error: error.data.message }, { status: 400 });
    }
    console.error('Attendance corrections POST error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create attendance correction' },
      { status: 500 },
    );
  }
}

export async function PATCH(req: NextRequest) {
  if (!(await hasValidPortalSession(req, ['admin', 'enrollment']))) {
    return unauthorizedApiResponse();
  }
  const body = await req.json().catch(() => ({}));
  const correctionId = optionalString(body.correction_id) || optionalString(body.correctionId);
  const requestId = body.request_id ?? body.requestId;
  const reason = optionalString(body.reason);
  if (!correctionId || !reason || reason.length > 1000 || typeof requestId !== 'string' || !requestId.trim() || requestId.length > 200) {
    return NextResponse.json({ error: 'correction_id, reason (1–1,000 characters), and request_id are required' }, { status: 400 });
  }
  try {
    const result = await convex.mutation((api as any).attendanceCorrections.reverse, {
      correctionId, requestId, reason,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to reverse correction';
    const status = message.includes('already been reversed') || message.includes('different details') ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
