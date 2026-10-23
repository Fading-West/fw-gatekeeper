export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import convex from '@/lib/convex';
import { unauthorizedApiResponse } from '@/lib/auth';
import { hasValidPortalSession } from '@/lib/portal-auth';
import { isValidLocalDateString, resolveRequestDate } from '@/lib/date';
import { api } from '../../../../convex/_generated/api';

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
    summary: {
      expected: 0,
      present: 0,
      late: 0,
      missing: 0,
      not_yet_due: 0,
      clocked_out: 0,
      departments: 0,
      open_exceptions: 0,
      recognition_reviews: 0,
      critical_actions: 0,
      kiosk_warnings: 0,
    },
    departments: [],
    workers: [],
    action_items: [],
    kiosks: {
      total: 0,
      counts: { online: 0, stale: 0, offline: 0, never_synced: 0 },
      rows: [],
    },
    schedules: { active_today: 0, total_active: 0 },
    shift_trust_brief: {
      readiness_status: 'attention',
      summary_sentence: `Morning readiness needs attention: 0/0 expected workers are present, 0 late, 0 missing, 0 open exceptions, and 0 kiosk warnings.`,
      primary_action: null,
      readiness_blockers: [],
      closeout_risks: [],
      source_counts: {
        expected: 0,
        present: 0,
        late: 0,
        missing: 0,
        not_yet_due: 0,
        open_exceptions: 0,
        critical_exceptions: 0,
        recognition_reviews: 0,
        missing_clock_outs: 0,
        corrections: 0,
        kiosk_warnings: 0,
      },
      generated_at: generatedAt,
      freshness: {
        label: 'Generated from deployment fallback evidence',
        generated_at: generatedAt,
      },
      source_labels: [
        'Active workers',
        'Active schedules',
        'Effective attendance',
        'Kiosk sync records',
        'Open shift exceptions',
        'Attendance corrections',
        'Ranked briefing actions',
      ],
    },
    backend_unavailable: true,
    warning: 'Shift briefing is waiting for the Convex functions to deploy.',
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
    const payload = await convex.query((api as any).shiftBriefing.summary, { date });
    return NextResponse.json(payload);
  } catch (error) {
    if (isMissingConvexFunction(error)) {
      return NextResponse.json(emptyResponse(date));
    }
    console.error('Shift briefing GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch shift briefing' }, { status: 500 });
  }
}
