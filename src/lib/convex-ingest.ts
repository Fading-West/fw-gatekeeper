export class SecuredIngestError extends Error {
  constructor(readonly status: number, readonly code?: string, readonly detail?: string) {
    super(`Secured Convex ingest failed with status ${status}.`);
  }
}

const INGEST_TIMEOUT_MS = 10_000;

function getConvexIngestBaseUrl() {
  const configuredUrl = process.env.CONVEX_INGEST_URL?.trim();
  if (configuredUrl) return configuredUrl.replace(/\/$/, '');

  const deploymentUrl = process.env.NEXT_PUBLIC_CONVEX_URL?.trim();
  if (!deploymentUrl) {
    throw new Error('CONVEX_INGEST_URL or NEXT_PUBLIC_CONVEX_URL is required for secured ingest.');
  }

  return deploymentUrl.replace(/\.convex\.cloud\/?$/, '.convex.site');
}

function getConvexIngestKey() {
  const key = process.env.CONVEX_INGEST_KEY?.trim();
  if (!key) throw new Error('CONVEX_INGEST_KEY is required for secured ingest.');
  return key;
}

async function postSecuredIngest<T>(path: string, body: unknown): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INGEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${getConvexIngestBaseUrl()}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${getConvexIngestKey()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null) as { code?: unknown; error?: unknown } | null;
      throw new SecuredIngestError(
        response.status,
        typeof body?.code === 'string' ? body.code : undefined,
        typeof body?.error === 'string' ? body.error : undefined,
      );
    }

    return await response.json() as T;
  } finally {
    clearTimeout(timeout);
  }
}

export function ingestAttendanceBatch(events: unknown[], checkpoint = false) {
  return postSecuredIngest<{ synced: number; acknowledged: number }>('/api/ingest/attendance/bulk', { events, ...(checkpoint ? { checkpoint: true } : {}) });
}

export function ingestAttendanceEvent(event: {
  workerId: string;
  eventType: string;
  kioskId?: string;
  timestamp?: string;
  idempotencyKey?: string;
  note?: string;
}) {
  return postSecuredIngest<{ id: string }>('/api/ingest/attendance', event);
}

export function ingestRecognitionAttemptBatch(attempts: unknown[]) {
  return postSecuredIngest<{ ingested: number; skipped: number; ids: string[] }>(
    '/api/ingest/recognition-attempts/bulk',
    { attempts },
  );
}

export type KioskHealthReport = {
  cameraOk?: boolean;
  modelOk?: boolean;
  livenessAvailable?: boolean;
  knownWorkers?: number;
  queuedLogs?: number;
  queuedAttempts?: number;
  degradedReason?: string;
  lastScanAt?: string;
};

export function updateKioskLastSync(kioskId: string, lastSync: string, health?: KioskHealthReport) {
  return postSecuredIngest<{ updated: boolean }>('/api/ingest/kiosks/last-sync', {
    kioskId,
    lastSync,
    ...(health ? { health } : {}),
  });
}

export function lookupKioskCredential(input: { mode: 'device'; credentialHash: string } | { mode: 'legacy'; identifier: string }) {
  return postSecuredIngest<{ documentId: string; kioskId: string; aliases: string[] } | null>('/api/ingest/kiosks/authenticate', input);
}

export function fetchWorkersForSync(since: string) {
  return postSecuredIngest<{ workers: unknown[] }>('/api/ingest/workers/sync', { since });
}

export function getAttendanceReceiptStatus(digests: string[]) {
  return postSecuredIngest<{ acknowledged: boolean[] }>('/api/ingest/attendance/receipts', { digests });
}
