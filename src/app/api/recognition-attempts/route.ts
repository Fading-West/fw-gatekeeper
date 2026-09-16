export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import convex from '@/lib/convex';
import { unauthorizedApiResponse } from '@/lib/auth';
import { hasValidPortalSession } from '@/lib/portal-auth';
import {
  RecognitionAttempt,
  RecognitionAttemptsResponse,
  RecognitionAttemptSummary,
  RecognitionReviewStatus,
} from '@/lib/types';
import { isValidLocalDateString, resolveRequestDate } from '@/lib/date';
import { api } from '../../../../convex/_generated/api';

const LOW_MARGIN_THRESHOLD = 0.08;

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeReviewStatus(value: unknown): RecognitionReviewStatus {
  if (value === 'confirmed' || value === 'corrected' || value === 'ignored') return value;
  return 'unreviewed';
}

function getConfidenceBand(score: number | null) {
  if (typeof score !== 'number') return null;
  if (score >= 0.45) return 'high' as const;
  if (score >= 0.3) return 'medium' as const;
  return 'low' as const;
}

function getReviewStatus(row: any): RecognitionReviewStatus {
  const reviewed = row.reviewed === 1 || row.reviewed === true;
  if (!reviewed) return 'unreviewed';
  return normalizeReviewStatus(row.reviewed_label ?? row.reviewedLabel ?? 'confirmed');
}

function asBooleanOrNull(value: unknown) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return null;
}

function normalizeAttempt(row: any): RecognitionAttempt {
  const score = optionalNumber(row.best_score ?? row.bestScore ?? row.score ?? row.confidence);
  return {
    id: String(row.id || row._id || ''),
    kiosk_id: row.kiosk_id ?? row.kioskId ?? null,
    kiosk_name: row.kiosk_name ?? row.kioskName ?? null,
    candidate_worker_id: row.candidate_worker_id ?? row.candidateWorkerId ?? row.worker_id ?? row.workerId ?? null,
    candidate_worker_name: row.candidate_worker_name ?? row.candidateWorkerName ?? row.worker_name ?? row.workerName ?? null,
    decision: String(row.decision || 'unknown'),
    review_status: getReviewStatus(row),
    confidence_band: row.confidence_band ?? row.confidenceBand ?? getConfidenceBand(score),
    score,
    second_score: optionalNumber(row.second_best_score ?? row.secondBestScore ?? row.second_score ?? row.secondScore),
    margin: optionalNumber(row.score_margin ?? row.scoreMargin ?? row.margin),
    threshold: optionalNumber(row.threshold),
    liveness_passed: asBooleanOrNull(row.liveness_confirmed ?? row.livenessConfirmed ?? row.liveness_passed ?? row.livenessPassed),
    timestamp: row.timestamp || row.created_at || row.createdAt || new Date().toISOString(),
    reviewed_at: row.reviewed_at ?? row.reviewedAt ?? null,
    review_note: row.reviewed_note ?? row.reviewedNote ?? row.review_note ?? row.reviewNote ?? null,
    model_version: row.model_version ?? row.modelVersion ?? null,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[midpoint - 1] + sorted[midpoint]) / 2 : sorted[midpoint];
}

function summarize(attempts: RecognitionAttempt[]): RecognitionAttemptSummary {
  const scores = attempts.flatMap((attempt) => (typeof attempt.score === 'number' ? [attempt.score] : []));

  return {
    accepted: attempts.filter((attempt) => attempt.decision.startsWith('accepted')).length,
    rejected: attempts.filter((attempt) => attempt.decision.startsWith('rejected')).length,
    unknown: attempts.filter((attempt) => attempt.decision === 'unknown').length,
    near_miss: attempts.filter((attempt) => attempt.decision === 'near_miss').length,
    low_margin_accepted: attempts.filter(
      (attempt) => attempt.decision.startsWith('accepted') && typeof attempt.margin === 'number' && attempt.margin <= LOW_MARGIN_THRESHOLD,
    ).length,
    median_score: median(scores),
    review_backlog: attempts.filter((attempt) => attempt.review_status === 'unreviewed' || attempt.decision === 'near_miss').length,
    total: attempts.length,
  };
}

function normalizeResponse(payload: any): RecognitionAttemptsResponse {
  const rawAttempts = Array.isArray(payload) ? payload : payload?.attempts || payload?.rows || [];
  const attempts = rawAttempts.map(normalizeAttempt);
  const computedSummary = summarize(attempts);
  const summary = payload?.summary || {};

  return {
    attempts,
    summary: {
      accepted: summary.accepted ?? computedSummary.accepted,
      rejected: summary.rejected ?? computedSummary.rejected,
      unknown: summary.unknown ?? computedSummary.unknown,
      near_miss: summary.near_miss ?? summary.nearMiss ?? computedSummary.near_miss,
      low_margin_accepted:
        summary.low_margin_accepted ?? summary.lowMarginAccepted ?? computedSummary.low_margin_accepted,
      median_score: summary.median_score ?? summary.medianScore ?? computedSummary.median_score,
      review_backlog: summary.review_backlog ?? summary.reviewBacklog ?? computedSummary.review_backlog,
      total: summary.total ?? computedSummary.total,
    },
  };
}

function emptyResponse(extra?: Partial<RecognitionAttemptsResponse>): RecognitionAttemptsResponse {
  return {
    attempts: [],
    summary: {
      accepted: 0,
      rejected: 0,
      unknown: 0,
      near_miss: 0,
      low_margin_accepted: 0,
      median_score: null,
      review_backlog: 0,
      total: 0,
    },
    ...extra,
  };
}

function isMissingConvexFunction(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('FunctionPathNotFound') || message.includes('Could not find public function');
}

export async function GET(req: NextRequest) {
  if (!(await hasValidPortalSession(req, ['admin', 'enrollment', 'viewer']))) {
    return unauthorizedApiResponse();
  }

  try {
    const searchParams = req.nextUrl.searchParams;
    const reviewStatus = optionalString(searchParams.get('review_status'));
    const attemptId = optionalString(searchParams.get('attempt_id'));
    const date = resolveRequestDate(searchParams);
    if (!isValidLocalDateString(date)) {
      return NextResponse.json({ error: 'date must use YYYY-MM-DD format' }, { status: 400 });
    }
    const result = await convex.query((api as any).recognitionAttempts.listByDate, {
      date,
      kioskId: optionalString(searchParams.get('kiosk_id')),
      reviewed: attemptId ? undefined : reviewStatus === 'unreviewed' ? false : reviewStatus && reviewStatus !== 'all' ? true : undefined,
      limit: attemptId ? 1000 : Number(searchParams.get('limit') || 100),
      decision: attemptId ? undefined : optionalString(searchParams.get('decision')),
      confidenceBand: attemptId ? undefined : optionalString(searchParams.get('confidence_band')),
      reviewStatus: attemptId ? undefined : reviewStatus,
    });
    const targetAttempt = attemptId
      ? await convex.query((api as any).recognitionAttempts.getById, { id: attemptId, date })
      : null;

    const rawAttempts = Array.isArray(result) ? result : result?.attempts || result?.rows || [];
    let response = normalizeResponse(targetAttempt ? { attempts: [targetAttempt, ...rawAttempts] } : result);
    if (attemptId) {
      const deduped = new Map(response.attempts.map((attempt) => [attempt.id, attempt]));
      response = { ...response, attempts: Array.from(deduped.values()) };
    }
    const decision = optionalString(searchParams.get('decision'));
    const confidenceBand = optionalString(searchParams.get('confidence_band'));
    response = {
      attempts: response.attempts.filter((attempt) => {
        const decisionMatches =
          attemptId ||
          !decision ||
          decision === 'all' ||
          attempt.decision === decision ||
          (decision === 'accepted' && attempt.decision.startsWith('accepted')) ||
          (decision === 'rejected' && attempt.decision.startsWith('rejected'));
        const reviewMatches =
          attemptId ||
          !reviewStatus ||
          reviewStatus === 'all' ||
          attempt.review_status === reviewStatus;
        const attemptMatches = !attemptId || attempt.id === attemptId;
        const confidenceMatches =
          attemptId ||
          !confidenceBand ||
          confidenceBand === 'all' ||
          attempt.confidence_band === confidenceBand;
        return attemptMatches && decisionMatches && reviewMatches && confidenceMatches;
      }),
      summary: response.summary,
    };
    response.summary = summarize(response.attempts);

    return NextResponse.json(response);
  } catch (error) {
    if (isMissingConvexFunction(error)) {
      return NextResponse.json(emptyResponse({
        backend_unavailable: true,
        warning: 'Recognition attempt storage is waiting for the Convex functions to deploy.',
      }));
    }
    console.error('Recognition attempts GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch recognition attempts' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  if (!(await hasValidPortalSession(req, ['admin', 'enrollment']))) {
    return unauthorizedApiResponse();
  }

  try {
    const body = await req.json().catch(() => ({}));
    const id = optionalString(body.id);
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

    const reviewStatus = optionalString(body.review_status) || optionalString(body.reviewStatus) || 'confirmed';
    const result = await convex.mutation((api as any).recognitionAttempts.updateReview, {
      id: id as any,
      reviewed: reviewStatus !== 'unreviewed',
      reviewedLabel: reviewStatus === 'unreviewed' ? undefined : reviewStatus,
      reviewedNote: optionalString(body.review_note) || optionalString(body.reviewNote),
    });

    return NextResponse.json(result || { ok: true });
  } catch (error) {
    console.error('Recognition attempts PATCH error:', error);
    return NextResponse.json({ error: 'Failed to review recognition attempt' }, { status: 500 });
  }
}
