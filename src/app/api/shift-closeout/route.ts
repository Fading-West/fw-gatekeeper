export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { ConvexError } from 'convex/values';
import convex from '@/lib/convex';
import { unauthorizedApiResponse } from '@/lib/auth';
import { hasValidPortalSession } from '@/lib/portal-auth';
import { isValidLocalDateString, resolveRequestDate } from '@/lib/date';
import { api } from '../../../../convex/_generated/api';

const VALID_ACTIONS = new Set(['save', 'complete', 'reopen']);

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

function emptyResponse(date: string) {
  const generatedAt = new Date().toISOString();
  return {
    date,
    generated_at: generatedAt,
    closeout: null,
    summary: {
      expected: 0,
      present: 0,
      late: 0,
      missing: 0,
      open_exceptions: 0,
      critical_exceptions: 0,
      missing_clock_outs: 0,
      recognition_reviews: 0,
      kiosk_warnings: 0,
      attendance_corrections: 0,
    },
    checklist: [],
    blockers: [],
    can_complete: false,
    suggested_note: '',
    closeout_draft: {
      generated_at: generatedAt,
      source_counts: {
        expected: 0,
        present: 0,
        late: 0,
        missing: 0,
        open_exceptions: 0,
        critical_exceptions: 0,
        missing_clock_outs: 0,
        recognition_reviews: 0,
        kiosk_warnings: 0,
        attendance_corrections: 0,
        total_exceptions: 0,
        reviewed_exceptions: 0,
        source_blockers: 0,
      },
      source_links: [],
      sections: [],
      narrative: '',
    },
    action_links: [],
    backend_unavailable: true,
    warning: 'Shift closeout is waiting for the Convex functions to deploy.',
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
    const payload = await convex.query((api as any).shiftCloseouts.get, { date });
    return NextResponse.json(payload);
  } catch (error) {
    if (isMissingConvexFunction(error)) {
      return NextResponse.json(emptyResponse(date));
    }
    console.error('Shift closeout GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch shift closeout' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  if (!(await hasValidPortalSession(req, ['admin', 'enrollment']))) {
    return unauthorizedApiResponse();
  }

  try {
    const body = await req.json().catch(() => ({}));
    const date = optionalString(body.date);
    const action = optionalString(body.action) || 'save';
    const requestId = body.request_id ?? body.requestId;
    const expectedRevision = body.expected_revision ?? body.expectedRevision;
    const revision = body.expected_revision === null || body.expectedRevision === null ? null : expectedRevision;
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 200 ||
        (revision !== null && (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0))) {
      return NextResponse.json({ error: 'request_id and expected_revision (null for a new record) are required', code: 'INVALID_CLOSEOUT_ACTION' }, { status: 400 });
    }

    if (!date) {
      return NextResponse.json({ error: 'date required' }, { status: 400 });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: 'date must use YYYY-MM-DD format' }, { status: 400 });
    }
    if (!VALID_ACTIONS.has(action)) {
      return NextResponse.json({ error: 'action must be save, complete, or reopen' }, { status: 400 });
    }

    const result = await convex.mutation((api as any).shiftCloseouts.save, {
      requestId,
      expectedRevision: revision,
      date,
      action,
      supervisorName: optionalString(body.supervisor_name) || optionalString(body.supervisorName),
      notes: optionalString(body.notes),
      acknowledgedBlockers: Boolean(body.acknowledged_blockers ?? body.acknowledgedBlockers),
      blockerEvidence: optionalString(body.blocker_evidence ?? body.blockerEvidence),
    });

    if (!result || result.requestId !== requestId || typeof result.actorUserId !== 'string' ||
        typeof result.id !== 'string' || !['open', 'completed', 'reopened'].includes(result.status) ||
        !Number.isSafeInteger(result.revision) || result.revision < 0) {
      return NextResponse.json({ error: 'The closeout action response was not confirmed. Retry the saved action.' }, { status: 502 });
    }
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ConvexError && ['CLOSEOUT_BLOCKERS_CHANGED', 'CLOSEOUT_ACKNOWLEDGEMENT_REQUIRED', 'CLOSEOUT_REVISION_CONFLICT', 'CLOSEOUT_REQUEST_CONFLICT'].includes(error.data?.code)) {
      return NextResponse.json({ error: error.data.message, code: error.data.code }, { status: 409 });
    }
    if (error instanceof ConvexError && error.data?.code === 'INVALID_CLOSEOUT_ACTION') {
      return NextResponse.json({ error: error.data.message, code: error.data.code }, { status: 400 });
    }
    console.error('Shift closeout PATCH error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update shift closeout' },
      { status: 500 },
    );
  }
}
