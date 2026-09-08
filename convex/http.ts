import { httpRouter } from 'convex/server';
import { auth } from './auth';
import { internal } from './_generated/api';
import { httpAction } from './_generated/server';

const http = httpRouter();
auth.addHttpRoutes(http);

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'x-fw-ingest-path': 'secured-convex-v1',
    },
  });
}

function publicJsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

type PublicKioskStatus = 'online' | 'stale' | 'offline' | 'never_synced';

function publicKioskStatus(lastSync: string | null, now: number): PublicKioskStatus {
  if (!lastSync) return 'never_synced';
  const ageMs = now - new Date(lastSync).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs <= 15 * 60 * 1000) return 'online';
  if (ageMs <= 60 * 60 * 1000) return 'stale';
  return 'offline';
}

const publicKioskHealth = httpAction(async (ctx) => {
  const checkedAtMs = Date.now();
  const kioskPage = await ctx.runQuery(internal.kiosks.internalHealthSnapshot, {});
  const inventoryTruncated = kioskPage.length > 100;
  const kiosks = kioskPage.slice(0, 100);
  const counts = { online: 0, stale: 0, offline: 0, never_synced: 0 };
  let reportingDeviceHealth = 0;
  let missingDeviceHealth = 0;
  let staleDeviceHealth = 0;
  let deviceIssues = 0;
  let queuedRecords = 0;

  for (const kiosk of kiosks) {
    counts[publicKioskStatus(kiosk.last_sync, checkedAtMs)] += 1;
    if (!kiosk.health) {
      missingDeviceHealth += 1;
      continue;
    }
    const healthAgeMs = checkedAtMs - new Date(kiosk.health.reported_at).getTime();
    if (!Number.isFinite(healthAgeMs) || healthAgeMs < 0 || healthAgeMs > 15 * 60 * 1000) {
      staleDeviceHealth += 1;
      continue;
    }
    reportingDeviceHealth += 1;
    if (kiosk.health.camera_ok === false || kiosk.health.model_ok === false || kiosk.health.degraded_reason) deviceIssues += 1;
    queuedRecords += Math.max(0, kiosk.health.queued_logs ?? 0) + Math.max(0, kiosk.health.queued_attempts ?? 0);
  }

  const degraded = kiosks.length === 0 || inventoryTruncated
    || counts.stale + counts.offline + counts.never_synced > 0
    || missingDeviceHealth + staleDeviceHealth > 0 || deviceIssues > 0 || queuedRecords > 0;
  return publicJsonResponse({
    status: degraded ? 'degraded' : 'healthy',
    timestamp: new Date(checkedAtMs).toISOString(),
    kiosks: {
      total: kiosks.length,
      ...counts,
      reporting_device_health: reportingDeviceHealth,
      missing_device_health: missingDeviceHealth,
      stale_device_health: staleDeviceHealth,
      device_issues: deviceIssues,
      queued_records: queuedRecords,
      inventory_truncated: inventoryTruncated,
    },
  });
});

function hasValidIngestCredential(request: Request) {
  const expected = process.env.CONVEX_INGEST_KEY?.trim();
  if (!expected) {
    console.error('secured_ingest_auth_unconfigured');
    return false;
  }

  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return false;
  return authorization.slice('Bearer '.length).trim() === expected;
}

async function readJsonBody(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function sanitizeKioskHealth(raw: unknown) {
  if (!raw || typeof raw !== 'object') return undefined;
  const source = raw as Record<string, unknown>;
  const asBool = (value: unknown) => (typeof value === 'boolean' ? value : undefined);
  const asCount = (value: unknown) => {
    const num = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(num) && num >= 0 ? Math.floor(num) : undefined;
  };
  const asText = (value: unknown) =>
    typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : undefined;

  return {
    cameraOk: asBool(source.cameraOk),
    modelOk: asBool(source.modelOk),
    livenessAvailable: asBool(source.livenessAvailable),
    knownWorkers: asCount(source.knownWorkers),
    queuedLogs: asCount(source.queuedLogs),
    queuedAttempts: asCount(source.queuedAttempts),
    degradedReason: asText(source.degradedReason),
    lastScanAt: asText(source.lastScanAt),
    reportedAt: new Date().toISOString(),
  };
}

const attendanceBulkIngest = httpAction(async (ctx, request) => {
  if (!hasValidIngestCredential(request)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const body = await readJsonBody(request);
  if (!body || !Array.isArray(body.events)) {
    return jsonResponse({ error: 'events array required' }, 400);
  }

  const result = await ctx.runMutation(internal.attendance.bulkCreateFromHttp, {
    events: body.events,
  });
  console.info('secured_ingest_attendance', { received: body.events.length, synced: result.synced });
  return jsonResponse(result);
});

const attendanceIngest = httpAction(async (ctx, request) => {
  if (!hasValidIngestCredential(request)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const body = await readJsonBody(request);
  if (!body || typeof body.workerId !== 'string' || typeof body.eventType !== 'string') {
    return jsonResponse({ error: 'workerId and eventType required' }, 400);
  }

  const result = await ctx.runMutation(internal.attendance.createFromHttp, {
    workerId: body.workerId,
    eventType: body.eventType,
    kioskId: typeof body.kioskId === 'string' ? body.kioskId : undefined,
    timestamp: typeof body.timestamp === 'string' ? body.timestamp : undefined,
    idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
  });
  console.info('secured_ingest_attendance_single', { workerId: body.workerId });
  return jsonResponse(result, 201);
});

const recognitionAttemptsBulkIngest = httpAction(async (ctx, request) => {
  if (!hasValidIngestCredential(request)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const body = await readJsonBody(request);
  if (!body || !Array.isArray(body.attempts)) {
    return jsonResponse({ error: 'attempts array required' }, 400);
  }

  const result = await ctx.runMutation(internal.recognitionAttempts.bulkIngestFromHttp, {
    attempts: body.attempts,
  });
  console.info('secured_ingest_recognition', {
    received: body.attempts.length,
    ingested: result.ingested,
    skipped: result.skipped,
  });
  return jsonResponse(result, 201);
});

const kioskLastSyncIngest = httpAction(async (ctx, request) => {
  if (!hasValidIngestCredential(request)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const body = await readJsonBody(request);
  if (!body || typeof body.kioskId !== 'string' || typeof body.lastSync !== 'string') {
    return jsonResponse({ error: 'kioskId and lastSync required' }, 400);
  }

  const result = await ctx.runMutation(internal.kiosks.updateLastSyncFromHttp, {
    kioskId: body.kioskId,
    lastSync: body.lastSync,
    health: sanitizeKioskHealth(body.health),
  });
  console.info('secured_ingest_kiosk_sync', { kioskId: body.kioskId, updated: result.updated });
  return jsonResponse(result);
});

const workerSyncRead = httpAction(async (ctx, request) => {
  if (!hasValidIngestCredential(request)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const body = await readJsonBody(request);
  const since = body && typeof body.since === 'string' ? body.since : undefined;
  const workers = await ctx.runQuery(internal.workers.listForSyncFromHttp, { since });
  console.info('secured_ingest_worker_sync', { returned: workers.length });
  return jsonResponse({ workers });
});

http.route({ path: '/api/ingest/attendance', method: 'POST', handler: attendanceIngest });
http.route({ path: '/api/ingest/attendance/bulk', method: 'POST', handler: attendanceBulkIngest });
http.route({ path: '/api/ingest/recognition-attempts/bulk', method: 'POST', handler: recognitionAttemptsBulkIngest });
http.route({ path: '/api/ingest/kiosks/last-sync', method: 'POST', handler: kioskLastSyncIngest });
http.route({ path: '/api/ingest/workers/sync', method: 'POST', handler: workerSyncRead });
http.route({ path: '/api/public/kiosk-health', method: 'GET', handler: publicKioskHealth });

export default http;
