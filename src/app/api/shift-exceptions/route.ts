export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { ConvexError } from 'convex/values';
import convex from '@/lib/convex';
import { unauthorizedApiResponse } from '@/lib/auth';
import { hasValidPortalSession } from '@/lib/portal-auth';
import { isValidLocalDateString, resolveRequestDate } from '@/lib/date';
import { api } from '../../../../convex/_generated/api';

const VALID_STATUSES = new Set(['open', 'reviewed', 'ignored', 'resolved']);

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getDate(req: NextRequest) {
  const date = resolveRequestDate(req.nextUrl.searchParams);
  return isValidLocalDateString(date) ? date : null;
}

function emptyResponse(date: string, extra?: Record<string, unknown>) {
  return {
    date,
    generated_at: new Date().toISOString(),
    exceptions: [],
    summary: {
      total: 0,
      open: 0,
      critical: 0,
      warning: 0,
      info: 0,
      by_severity: { critical: 0, warning: 0, info: 0 },
      by_type: {},
      by_status: { open: 0, reviewed: 0, ignored: 0, resolved: 0 },
    },
    ...extra,
  };
}

function isMissingConvexFunction(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('FunctionPathNotFound') || message.includes('Could not find public function');
}

function typeLabel(value: unknown) {
  const type = typeof value === 'string' && value.trim() ? value.trim() : 'exception';
  return type.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function sourceHref(exception: any) {
  return exception?.links?.activity_log || exception?.links?.recognition_lab || exception?.links?.kiosk || null;
}

function fallbackSuggestedResolution(exception: any) {
  const key = typeof exception?.key === 'string' && exception.key.trim() ? exception.key : 'unknown-exception';
  const issue = typeLabel(exception?.type);
  const worker = typeof exception?.worker_name === 'string' && exception.worker_name.trim()
    ? exception.worker_name.trim()
    : 'Unknown worker';
  const href = sourceHref(exception);

  return {
    action: 'review_only',
    label: 'Review exception',
    cta: 'Review source',
    reason: `${issue}: supervisor should review source evidence for ${worker}. Source exception ${key}.`,
    corrected_time: null,
    original_attendance_id: null,
    href,
    source_href: href,
    requires_worker: false,
    requires_original_event: false,
    can_apply: false,
    disabled_reason: 'Suggested correction details are waiting for the updated Convex exception payload; review the source evidence before applying corrections.',
    source_exception_key: key,
  };
}

function hasSuggestedResolution(exception: any) {
  return exception?.suggested_resolution && typeof exception.suggested_resolution === 'object';
}

function normalizeShiftExceptionsPayload(payload: any) {
  if (!payload || !Array.isArray(payload.exceptions)) return payload;
  return {
    ...payload,
    exceptions: payload.exceptions.map((exception: any) => ({
      ...exception,
      suggested_resolution: hasSuggestedResolution(exception)
        ? exception.suggested_resolution
        : fallbackSuggestedResolution(exception),
    })),
  };
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
    const payload = await convex.query((api as any).shiftExceptions.summary, { date });
    return NextResponse.json(normalizeShiftExceptionsPayload(payload));
  } catch (error) {
    if (isMissingConvexFunction(error)) {
      return NextResponse.json(emptyResponse(date, {
        backend_unavailable: true,
        warning: 'Shift exception storage is waiting for the Convex functions to deploy.',
      }));
    }
    console.error('Shift exceptions GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch shift exceptions' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  if (!(await hasValidPortalSession(req, ['admin', 'enrollment']))) {
    return unauthorizedApiResponse();
  }

  try {
    const body = await req.json().catch(() => ({}));
    const exceptionKey = optionalString(body.exception_key) || optionalString(body.exceptionKey);
    const sourceFingerprint = optionalString(body.source_fingerprint) || optionalString(body.sourceFingerprint);
    const date = optionalString(body.date);
    const type = optionalString(body.type);
    const status = optionalString(body.status) || 'reviewed';

    if (!exceptionKey || !date || !type) {
      return NextResponse.json({ error: 'exception_key, date, and type required' }, { status: 400 });
    }
    if (!isValidLocalDateString(date)) {
      return NextResponse.json({ error: 'date must use YYYY-MM-DD format' }, { status: 400 });
    }
    if (!VALID_STATUSES.has(status)) {
      return NextResponse.json({ error: 'status must be open, reviewed, ignored, or resolved' }, { status: 400 });
    }

    const result = await convex.mutation((api as any).shiftExceptions.review, {
      exceptionKey,
      sourceFingerprint,
      date,
      type,
      status,
      note: optionalString(body.note),
    });

    return NextResponse.json(result || { ok: true });
  } catch (error) {
    if (error instanceof ConvexError && error.data?.code === 'EXCEPTION_SOURCE_CONFLICT') {
      return NextResponse.json({ error: error.data.message, code: error.data.code }, { status: 409 });
    }
    if (error instanceof ConvexError && error.data?.code === 'INVALID_EXCEPTION_SOURCE') {
      return NextResponse.json({ error: error.data.message, code: error.data.code }, { status: 400 });
    }
    console.error('Shift exceptions PATCH error:', error);
    return NextResponse.json({ error: 'Failed to review shift exception' }, { status: 500 });
  }
}
