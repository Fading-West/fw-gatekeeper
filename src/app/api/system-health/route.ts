export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import convex from '@/lib/convex';
import { api } from '../../../../convex/_generated/api';
import { hasValidPortalSession } from '@/lib/portal-auth';
import { unauthorizedApiResponse } from '@/lib/auth';
import { isValidLocalDateString, resolveRequestDate } from '@/lib/date';

const FACE_SERVICE_FALLBACK = 'https://fw-face-service.onrender.com';
const ONLINE_THRESHOLD_MS = 15 * 60 * 1000;
const STALE_THRESHOLD_MS = 60 * 60 * 1000;
const CACHE_TTL_MS = 30 * 1000;

type KioskStatus = 'online' | 'stale' | 'offline' | 'never_synced';
type KioskDeviceHealth = {
  camera_ok: boolean | null;
  model_ok: boolean | null;
  liveness_available: boolean | null;
  known_workers: number | null;
  queued_logs: number | null;
  queued_attempts: number | null;
  degraded_reason: string | null;
  last_scan_at: string | null;
  reported_at: string;
};
type FaceServiceHealth = {
  status: 'online' | 'degraded' | 'offline';
  http_status: number | null;
  latency_ms: number;
  version: string | null;
  model_ready: boolean;
};

type SystemHealthPayload = {
  checked_at: string;
  portal: { status: 'online'; checked_at: string };
  face_service: FaceServiceHealth;
  kiosks: {
    total: number;
    counts: Record<KioskStatus, number>;
    stale_threshold_minutes: number;
    offline_threshold_minutes: number;
    rows: Array<{
      id: string;
      name: string;
      kiosk_id: string | null;
      type: string;
      location: string;
      last_sync: string | null;
      status: KioskStatus;
      expected_worker_count: number;
      last_attendance_upload: string | null;
      health: KioskDeviceHealth | null;
      device_issues: string[];
    }>;
  };
  sync: { ready_worker_count: number; last_attendance_upload: string | null };
  warnings: string[];
};

const cache = new Map<string, { expiresAt: number; payload: SystemHealthPayload }>();

function asHealthUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    if (url.pathname.endsWith('/encode')) {
      url.pathname = url.pathname.replace(/\/encode$/, '/health');
    } else if (!url.pathname.endsWith('/health')) {
      url.pathname = `${url.pathname.replace(/\/$/, '')}/health`;
    }
    url.search = '';
    return url.toString();
  } catch {
    return `${FACE_SERVICE_FALLBACK}/health`;
  }
}

function getKioskStatus(lastSync: string | null): KioskStatus {
  if (!lastSync) return 'never_synced';
  const ageMs = Date.now() - new Date(lastSync).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return 'online';
  if (ageMs <= ONLINE_THRESHOLD_MS) return 'online';
  if (ageMs <= STALE_THRESHOLD_MS) return 'stale';
  return 'offline';
}

const DEGRADED_REASON_LABELS: Record<string, string> = {
  camera_error: 'camera failure — the kiosk cannot scan',
  model_error: 'recognition model failed to load — all scans are rejected',
  encoding_mismatch: 'face encodings do not match the kiosk model — all workers are rejected',
  no_workers_synced: 'no workers synced — every scan is rejected',
  liveness_unavailable: 'blink verification unavailable — scans are recorded unverified',
};

function getDeviceIssues(health: KioskDeviceHealth | null): string[] {
  if (!health) return [];
  const issues: string[] = [];
  if (health.camera_ok === false) issues.push(DEGRADED_REASON_LABELS.camera_error);
  if (health.model_ok === false) issues.push(DEGRADED_REASON_LABELS.model_error);
  if (health.degraded_reason && health.degraded_reason !== 'camera_error' && health.degraded_reason !== 'model_error') {
    issues.push(DEGRADED_REASON_LABELS[health.degraded_reason] ?? `degraded (${health.degraded_reason})`);
  }
  if ((health.queued_logs ?? 0) > 0) {
    issues.push(`${health.queued_logs} attendance record${health.queued_logs === 1 ? '' : 's'} queued on-device`);
  }
  return issues;
}

function latestTimestamp(records: Array<{ timestamp?: string }>) {
  let latest: string | null = null;
  let latestMs = -Infinity;

  for (const record of records) {
    if (!record.timestamp) continue;
    const ms = new Date(record.timestamp).getTime();
    if (Number.isFinite(ms) && ms > latestMs) {
      latestMs = ms;
      latest = record.timestamp;
    }
  }

  return latest;
}

function normalizeIdentifier(value: unknown) {
  return String(value || '').trim().toLowerCase();
}

function getDate(req: NextRequest, now: Date) {
  const rawDate = req.nextUrl.searchParams.get('date');
  const date = resolveRequestDate(req.nextUrl.searchParams, { now });
  if (rawDate && !isValidLocalDateString(rawDate)) return null;
  return isValidLocalDateString(date) ? date : null;
}

export async function GET(req: NextRequest) {
  if (!(await hasValidPortalSession(req, ['admin', 'enrollment', 'viewer']))) {
    return unauthorizedApiResponse();
  }

  const checkedAt = new Date();
  const now = checkedAt.toISOString();
  const date = getDate(req, checkedAt);
  if (!date) {
    return NextResponse.json({ error: 'date must use YYYY-MM-DD format' }, { status: 400 });
  }

  const cached = cache.get(date);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(cached.payload);
  }

  try {
    const faceHealthUrl = asHealthUrl(process.env.FACE_ENCODE_URL || process.env.FACE_SERVICE_URL || FACE_SERVICE_FALLBACK);

    const [kiosks, workers, attendanceToday, faceService] = await Promise.all([
      convex.query(api.kiosks.list, {}),
      convex.query(api.workers.list, { includeEncodings: false }),
      convex.query(api.attendance.list, { date, includeCorrections: false }),
      fetchFaceHealth(faceHealthUrl),
    ]);

    const readyWorkerCount = workers.filter((worker: any) => worker.encoding_status === 'valid' || worker.has_face_encoding).length;
    const kioskRows = kiosks.map((kiosk: any) => {
      const status = getKioskStatus(kiosk.last_sync);
      const kioskCandidates = [kiosk.id, kiosk.kiosk_id, kiosk.name]
        .map(normalizeIdentifier)
        .filter(Boolean);
      const matchingEvents = attendanceToday.filter((event: any) => {
        const eventKiosk = normalizeIdentifier(event.kiosk_id);
        return eventKiosk && kioskCandidates.includes(eventKiosk);
      });

      return {
        id: kiosk.id,
        name: kiosk.name,
        kiosk_id: kiosk.kiosk_id,
        type: kiosk.type,
        location: kiosk.location,
        last_sync: kiosk.last_sync,
        status,
        expected_worker_count: readyWorkerCount,
        last_attendance_upload: latestTimestamp(matchingEvents),
        health: kiosk.health ?? null,
        device_issues: getDeviceIssues(kiosk.health ?? null),
      };
    });

    const counts = kioskRows.reduce(
      (acc, kiosk) => {
        acc[kiosk.status] += 1;
        return acc;
      },
      { online: 0, stale: 0, offline: 0, never_synced: 0 } as Record<KioskStatus, number>,
    );

    const deviceWarnings = kioskRows.flatMap((kiosk) =>
      kiosk.device_issues.map((issue) => `Kiosk ${kiosk.name}: ${issue}`),
    );

    const warnings = [
      ...deviceWarnings,
      ...(faceService.status === 'offline' ? ['Face service is offline or not responding. Enrollment may fail.'] : []),
      ...(faceService.status === 'degraded' ? ['Face service is degraded. Enrollment or recognition may be unreliable.'] : []),
      ...(faceService.status !== 'offline' && !faceService.model_ready ? ['Face service models are not ready. Face enrollment may fail.'] : []),
      ...(kiosks.length === 0 ? ['No kiosks are registered yet. Add kiosks before launch.'] : []),
      ...(counts.stale > 0 ? [`${counts.stale} kiosk${counts.stale === 1 ? '' : 's'} have not synced in 15+ minutes.`] : []),
      ...(counts.offline + counts.never_synced > 0
        ? [`${counts.offline + counts.never_synced} kiosk${counts.offline + counts.never_synced === 1 ? '' : 's'} are offline or have never synced.`]
        : []),
    ];

    const payload: SystemHealthPayload = {
      checked_at: now,
      portal: { status: 'online', checked_at: now },
      face_service: faceService,
      kiosks: {
        total: kiosks.length,
        counts,
        stale_threshold_minutes: ONLINE_THRESHOLD_MS / 60000,
        offline_threshold_minutes: STALE_THRESHOLD_MS / 60000,
        rows: kioskRows,
      },
      sync: {
        ready_worker_count: readyWorkerCount,
        last_attendance_upload: latestTimestamp(attendanceToday),
      },
      warnings,
    };

    cache.set(date, { expiresAt: Date.now() + CACHE_TTL_MS, payload });
    return NextResponse.json(payload);
  } catch (error) {
    console.error('System health error:', error);
    return NextResponse.json({ error: 'Failed to fetch system health' }, { status: 500 });
  }
}

async function fetchFaceHealth(url: string): Promise<FaceServiceHealth> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(url, { cache: 'no-store', signal: controller.signal });
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }

    // Detection runs on OpenCV's bundled Haar cascade; only the recognition model is downloaded.
    const modelReady = Boolean(body?.rec_exists);
    const healthy = res.ok && (!body?.status || body.status === 'ok') && modelReady;
    return {
      status: healthy ? 'online' : 'degraded',
      http_status: res.status,
      latency_ms: Date.now() - started,
      version: body?.version || null,
      model_ready: modelReady,
    };
  } catch (error) {
    console.error('Face service health check failed:', error);
    return {
      status: 'offline',
      http_status: null,
      latency_ms: Date.now() - started,
      version: null,
      model_ready: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}
