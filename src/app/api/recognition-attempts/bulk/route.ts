export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { ingestRecognitionAttemptBatch, SecuredIngestError } from '@/lib/convex-ingest';
import { unauthorizedApiResponse } from '@/lib/auth';
import { authenticateKiosk, kioskClaims, kioskEvidenceId } from '@/lib/kiosk-device-auth';

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

const metricLimits: [string[], number, number][] = [
  [['best_score', 'bestScore', 'score', 'confidence', 'second_best_score', 'secondBestScore', 'second_score', 'secondScore'], -1, 1],
  [['score_margin', 'scoreMargin', 'margin'], -2, 2],
  [['threshold', 'match_threshold', 'matchThreshold', 'image_quality', 'imageQuality', 'face_quality', 'faceQuality'], 0, 1],
  [['brightness'], 0, 255], [['blur'], 0, Number.MAX_VALUE],
];
function invalidRawMetric(raw: Record<string, unknown>): string | undefined {
  for (const [fields, minimum, maximum] of metricLimits) {
    for (const field of fields) {
      const value = raw[field];
      if (value !== undefined && value !== null && (typeof value !== 'number' ||
          !Number.isFinite(value) || value < minimum - 1e-12 || value > maximum + 1e-12)) return field;
    }
  }
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
    timestamp: (optionalString(raw.timestamp) || optionalString(raw.created_at) || optionalString(raw.createdAt))!,
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
    if (attempts.some((attempt: unknown) => !attempt || typeof attempt !== 'object' || Array.isArray(attempt))) {
      return NextResponse.json({ error: 'Each attempt must be a JSON object' }, { status: 400 });
    }
    const claims = [...kioskClaims(body), ...attempts.flatMap((attempt: unknown) =>
      attempt && typeof attempt === 'object' && !Array.isArray(attempt) ? kioskClaims(attempt as Record<string, unknown>) : [])];
    const identity = await authenticateKiosk(req, claims);
    if (!identity) return unauthorizedApiResponse();

    for (const attempt of attempts) {
      const invalid = invalidRawMetric(attempt);
      if (invalid) return NextResponse.json({ error: `Invalid recognition metric: ${invalid}`, code: 'INVALID_RECOGNITION_METRIC' }, { status: 400 });
    }

    if (attempts.some((raw: any) => !(optionalString(raw.timestamp) || optionalString(raw.created_at) || optionalString(raw.createdAt)))) {
      return NextResponse.json({ error: 'Each recognition attempt requires its captured timestamp for safe retry.', code: 'INVALID_RECOGNITION_TIMESTAMP' }, { status: 400 });
    }

    const mapped = attempts.map((attempt: any) => normalizeAttempt(attempt, kioskEvidenceId(identity, attempt, body)));
    const result = await ingestRecognitionAttemptBatch(mapped);
    console.info('next_secured_ingest_recognition', {
      received: mapped.length,
      ingested: result.ingested,
      skipped: result.skipped,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof SecuredIngestError && error.status === 400 &&
        ['INVALID_RECOGNITION_TIMESTAMP', 'INVALID_RECOGNITION_METRIC'].includes(error.code || '')) {
      return NextResponse.json({ error: error.detail || 'Invalid recognition evidence', code: error.code }, { status: 400 });
    }
    if (error instanceof SecuredIngestError && error.status === 409) {
      return NextResponse.json({ error: 'Recognition attempt ID was reused with different evidence.', code: 'RECOGNITION_ATTEMPT_CONFLICT' }, { status: 409 });
    }
    console.error('Recognition attempts bulk POST error:', error);
    return NextResponse.json({ error: 'Failed to record recognition attempt batch' }, { status: 500 });
  }
}
