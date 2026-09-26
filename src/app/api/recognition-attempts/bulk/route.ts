export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { ingestRecognitionAttemptBatch, SecuredIngestError } from '@/lib/convex-ingest';
import { unauthorizedApiResponse } from '@/lib/auth';
import { authenticateKiosk, kioskClaims } from '@/lib/kiosk-device-auth';

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === 'true') return true;
  if (value === 0 || value === 'false') return false;
  return undefined;
}

function normalizeAttempt(raw: any, kioskId: string) {
  const bestScore = optionalNumber(raw.best_score) ?? optionalNumber(raw.bestScore) ?? optionalNumber(raw.score) ?? optionalNumber(raw.confidence);
  const secondBestScore = optionalNumber(raw.second_best_score) ?? optionalNumber(raw.secondBestScore) ?? optionalNumber(raw.second_score) ?? optionalNumber(raw.secondScore);
  const scoreMargin = optionalNumber(raw.score_margin) ?? optionalNumber(raw.scoreMargin) ?? optionalNumber(raw.margin);

  return {
    sourceAttemptId:
      optionalString(raw.source_attempt_id) ||
      optionalString(raw.sourceAttemptId) ||
      optionalString(raw.idempotency_key) ||
      optionalString(raw.idempotencyKey) ||
      optionalString(raw.id),
    legacySourceAttemptId: optionalString(raw.legacy_source_attempt_id) || optionalString(raw.legacySourceAttemptId),
    kioskId,
    timestamp: optionalString(raw.timestamp) || optionalString(raw.created_at) || optionalString(raw.createdAt) || new Date().toISOString(),
    faceDetected:
      optionalBoolean(raw.face_detected) ??
      optionalBoolean(raw.faceDetected) ??
      (bestScore !== undefined || optionalString(raw.candidate_worker_name) !== undefined),
    candidateWorkerId:
      optionalString(raw.candidate_worker_id) ||
      optionalString(raw.candidateWorkerId) ||
      optionalString(raw.worker_id) ||
      optionalString(raw.workerId),
    candidateWorkerName:
      optionalString(raw.candidate_worker_name) ||
      optionalString(raw.candidateWorkerName) ||
      optionalString(raw.worker_name) ||
      optionalString(raw.workerName),
    bestScore,
    secondBestScore,
    scoreMargin,
    decision: optionalString(raw.decision) || 'unknown',
    threshold:
      optionalNumber(raw.threshold) ??
      optionalNumber(raw.match_threshold) ??
      optionalNumber(raw.matchThreshold) ??
      0.3,
    livenessConfirmed:
      optionalBoolean(raw.liveness_confirmed) ??
      optionalBoolean(raw.livenessConfirmed) ??
      optionalBoolean(raw.liveness_passed) ??
      optionalBoolean(raw.livenessPassed),
    modelVersion:
      optionalString(raw.model_version) ||
      optionalString(raw.modelVersion),
    imageQuality: optionalNumber(raw.image_quality) ?? optionalNumber(raw.imageQuality),
    faceQuality: optionalNumber(raw.face_quality) ?? optionalNumber(raw.faceQuality),
    brightness: optionalNumber(raw.brightness),
    blur: optionalNumber(raw.blur),
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'A JSON object is required' }, { status: 400 });
    const attempts = body.attempts || body.events || body.logs;

    if (!Array.isArray(attempts)) {
      return NextResponse.json({ error: 'attempts (or events/logs) array required' }, { status: 400 });
    }
    const claims = [...kioskClaims(body), ...attempts.flatMap((attempt: unknown) =>
      attempt && typeof attempt === 'object' && !Array.isArray(attempt) ? kioskClaims(attempt as Record<string, unknown>) : [])];
    const identity = await authenticateKiosk(req, claims);
    if (!identity) return unauthorizedApiResponse();

    const mapped = attempts.map((attempt: any) => normalizeAttempt(attempt, identity.kioskId));
    const result = await ingestRecognitionAttemptBatch(mapped);
    console.info('next_secured_ingest_recognition', {
      received: mapped.length,
      ingested: result.ingested,
      skipped: result.skipped,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof SecuredIngestError && error.status === 409) {
      return NextResponse.json({ error: 'Recognition attempt ID was reused with different evidence.', code: 'RECOGNITION_ATTEMPT_CONFLICT' }, { status: 409 });
    }
    console.error('Recognition attempts bulk POST error:', error);
    return NextResponse.json({ error: 'Failed to record recognition attempt batch' }, { status: 500 });
  }
}
