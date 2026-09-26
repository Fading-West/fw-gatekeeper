import { validateReceiptDigests } from "./attendance";
import { ConvexError } from "convex/values";
import { validateAttendanceBatch, validateAttendanceEvent } from "./attendanceValidation";
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

function activityJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
}

async function hasValidActivityCredential(request: Request) {
  const expected = process.env.ACTIVITY_FW_GATEWAY_TOKEN?.trim();
  if (!expected || expected.length < 32) return false;
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return false;
  const presented = authorization.slice('Bearer '.length).trim();
  if (presented.length !== expected.length) return false;

  const encoder = new TextEncoder();
  const [presentedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(presented)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const presentedBytes = new Uint8Array(presentedDigest);
  const expectedBytes = new Uint8Array(expectedDigest);
  let difference = 0;
  for (let index = 0; index < presentedBytes.length; index += 1) {
    difference |= presentedBytes[index] ^ expectedBytes[index];
  }
  return difference === 0;
}

const activityFeedRead = httpAction(async (ctx, request) => {
  const expected = process.env.ACTIVITY_FW_GATEWAY_TOKEN?.trim();
  const sourceAccountId = process.env.ACTIVITY_FW_GATEWAY_ACCOUNT_ID?.trim();
  if (!expected || expected.length < 32 || !sourceAccountId) {
    console.error('activity_feed_unconfigured');
    return activityJsonResponse({ error: 'Activity feed is not configured' }, 503);
  }
  if (!(await hasValidActivityCredential(request))) {
    return activityJsonResponse({ error: 'Unauthorized' }, 401);
  }

  const result = await ctx.runQuery(internal.activityFeed.read, {
    sourceAccountId,
    queriedAt: new Date().toISOString(),
  });
  if (!result.authorized) {
    const status = result.reason === 'mapping_missing' ? 503 : 403;
    return activityJsonResponse({ error: status === 503 ? 'Activity source account is not configured' : 'Forbidden' }, status);
  }
  if ('error' in result) {
    console.error('activity_feed_scan_limit_exceeded');
    return activityJsonResponse({ error: 'Activity feed unavailable' }, 503);
  }
  return activityJsonResponse(result.payload);
});

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
    if (kiosk.health.camera_ok === false || kiosk.health.model_ok === false || kiosk.health.degraded_reason) deviceIssues += 1;
    queuedRecords += Math.max(0, kiosk.health.queued_logs ?? 0) + Math.max(0, kiosk.health.queued_attempts ?? 0);
    if (typeof kiosk.health.camera_ok !== 'boolean' || typeof kiosk.health.model_ok !== 'boolean') {
      missingDeviceHealth += 1;
      continue;
    }
    reportingDeviceHealth += 1;
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

  try {
    const events = validateAttendanceBatch(body.events);
    if (body.checkpoint !== undefined && typeof body.checkpoint !== "boolean") {
      return jsonResponse({ error: 'checkpoint must be a boolean' }, 400);
    }
    const receiptHash = body.checkpoint ? Array.from(new Uint8Array(await crypto.subtle.digest(
      'SHA-256', new TextEncoder().encode(JSON.stringify(events)),
    )), byte => byte.toString(16).padStart(2, '0')).join('') : undefined;
    const result = await ctx.runMutation(internal.attendance.bulkCreateFromHttp, { events, receiptHash });
    console.info('secured_ingest_attendance', { received: events.length, synced: result.synced });
    return jsonResponse(result);
  } catch (error) {
    if (error instanceof ConvexError) return jsonResponse({ error: error.data.message, code: error.data.code }, 400);
    throw error;
  }
});

const attendanceReceiptStatus = httpAction(async (ctx, request) => {
  if (!hasValidIngestCredential(request)) return jsonResponse({ error: 'Unauthorized' }, 401);
  const body = await readJsonBody(request);
  try {
    const digests = validateReceiptDigests(body?.digests);
    const acknowledged = await ctx.runQuery(internal.attendance.receiptStatus, { digests });
    return jsonResponse({ acknowledged });
  } catch (error) {
    if (error instanceof ConvexError) return jsonResponse({ error: error.data.message }, 400);
    throw error;
  }
});

const attendanceIngest = httpAction(async (ctx, request) => {
  if (!hasValidIngestCredential(request)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const body = await readJsonBody(request);
  if (!body || typeof body.workerId !== 'string' || typeof body.eventType !== 'string') {
    return jsonResponse({ error: 'workerId and eventType required' }, 400);
  }

  try {
    const event = validateAttendanceEvent({ ...body, timestamp: body.timestamp ?? new Date().toISOString() });
    const result = await ctx.runMutation(internal.attendance.createFromHttp, {
      workerId: event.workerId,
      eventType: event.eventType,
      kioskId: event.kioskId,
      timestamp: body.timestamp === undefined ? undefined : event.timestamp,
      idempotencyKey: event.idempotencyKey,
      note: event.note,
    });
    console.info('secured_ingest_attendance_single', { workerId: event.workerId });
    return jsonResponse(result, 201);
  } catch (error) {
    if (error instanceof ConvexError) return jsonResponse({ error: error.data.message }, 400);
    throw error;
  }
});

const recognitionAttemptsBulkIngest = httpAction(async (ctx, request) => {
  if (!hasValidIngestCredential(request)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const body = await readJsonBody(request);
  if (!body || !Array.isArray(body.attempts)) {
    return jsonResponse({ error: 'attempts array required' }, 400);
  }

  try {
    const result = await ctx.runMutation(internal.recognitionAttempts.bulkIngestFromHttp, {
      attempts: body.attempts,
    });
    console.info('secured_ingest_recognition', {
      received: body.attempts.length,
      ingested: result.ingested,
      skipped: result.skipped,
    });
    return jsonResponse(result, 201);
  } catch (error) {
    if (error instanceof ConvexError && error.data?.code === 'RECOGNITION_ATTEMPT_CONFLICT') {
      return jsonResponse({ error: error.data.message, code: error.data.code }, 409);
    }
    throw error;
  }
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

const kioskAuthenticate = httpAction(async (ctx, request) => {
  if (!hasValidIngestCredential(request)) return jsonResponse({ error: 'Unauthorized' }, 401);
  const body = await readJsonBody(request);
  if (!body || typeof body !== 'object') return jsonResponse({ error: 'Credential lookup required' }, 400);
  if (body.mode === 'device' && typeof body.credentialHash === 'string') {
    return jsonResponse(await ctx.runQuery(internal.kiosks.authenticateDevice, { credentialHash: body.credentialHash }));
  }
  if (body.mode === 'legacy' && typeof body.identifier === 'string') {
    return jsonResponse(await ctx.runQuery(internal.kiosks.authenticateLegacy, { identifier: body.identifier }));
  }
  return jsonResponse({ error: 'Credential lookup required' }, 400);
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

http.route({ path: '/api/ingest/attendance/receipts', method: 'POST', handler: attendanceReceiptStatus });
http.route({ path: '/api/ingest/attendance', method: 'POST', handler: attendanceIngest });
http.route({ path: '/api/ingest/attendance/bulk', method: 'POST', handler: attendanceBulkIngest });
http.route({ path: '/api/ingest/recognition-attempts/bulk', method: 'POST', handler: recognitionAttemptsBulkIngest });
http.route({ path: '/api/ingest/kiosks/last-sync', method: 'POST', handler: kioskLastSyncIngest });
http.route({ path: '/api/ingest/kiosks/authenticate', method: 'POST', handler: kioskAuthenticate });
http.route({ path: '/api/ingest/workers/sync', method: 'POST', handler: workerSyncRead });
http.route({ path: '/api/public/kiosk-health', method: 'GET', handler: publicKioskHealth });
http.route({ path: '/api/internal/activity', method: 'GET', handler: activityFeedRead });

export default http;
