export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { hasDeviceKeyFormat, unauthorizedApiResponse } from '@/lib/auth';
import { authenticateKiosk } from '@/lib/kiosk-device-auth';
import { fetchWorkersForSync, updateKioskLastSync, issueRosterReceipt, type KioskHealthReport } from '@/lib/convex-ingest';
import { hasValidPortalSession } from '@/lib/portal-auth';

function parseKioskHealth(params: URLSearchParams): KioskHealthReport | undefined {
  const bool = (key: string) => {
    const value = params.get(key);
    return value === null ? undefined : value === '1' || value === 'true';
  };
  const count = (key: string) => {
    const value = params.get(key);
    if (value === null) return undefined;
    const num = Number(value);
    return Number.isFinite(num) && num >= 0 ? Math.floor(num) : undefined;
  };
  const text = (key: string) => params.get(key)?.trim() || undefined;

  const health: KioskHealthReport = {
    cameraOk: bool('camera_ok'),
    modelOk: bool('model_ok'),
    livenessAvailable: bool('liveness_available'),
    knownWorkers: count('known_workers'),
    queuedLogs: count('queued_logs'),
    queuedAttempts: count('queued_attempts'),
    degradedReason: text('degraded_reason'),
    lastScanAt: text('last_scan_at'),
  };
  return Object.values(health).some((value) => value !== undefined) ? health : undefined;
}

export async function GET(req: NextRequest) {
  const requestedId = req.nextUrl.searchParams.get('kiosk_id');
  const admin = await hasValidPortalSession(req, ['admin']);
  const identity = admin ? null : await authenticateKiosk(req, [requestedId]);
  if (!admin && !identity) return unauthorizedApiResponse();

  // The credential lookup already resolved the exact row. A configured alias
  // may collide with another legacy kiosk and must not be resolved again.
  const kioskId = identity?.documentId || requestedId;
  const since = req.nextUrl.searchParams.get('since') || '1970-01-01T00:00:00.000Z';
  const receiptProtocol = Boolean(identity) && hasDeviceKeyFormat(req) && req.nextUrl.searchParams.get('roster_receipt') === '1';

  if (!kioskId) return NextResponse.json({ error: 'kiosk_id required' }, { status: 400 });

  const lastSync = new Date().toISOString();
  try {
    const result = await updateKioskLastSync(kioskId, lastSync, parseKioskHealth(req.nextUrl.searchParams));
    if (!result.updated) {
      console.warn('next_secured_ingest_kiosk_sync_not_found', { kioskId });
    }
  } catch (error) {
    console.error('next_secured_ingest_kiosk_sync_failed', {
      kioskId,
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }

  if (receiptProtocol) {
    // Issue before reading the complete roster: the receipt's Convex clock
    // cannot certify a purge that raced the roster download afterward.
    try {
      const issued = await issueRosterReceipt(kioskId);
      const forceFull = req.nextUrl.searchParams.get('full_roster') === '1';
      const { workers } = await fetchWorkersForSync(forceFull ? '' : issued.since ?? '', true);
      return NextResponse.json({ workers, synced_at: issued.issuedAt, roster_receipt: issued.receipt,
        full_roster: forceFull || !issued.since });
    } catch (error) {
      console.error('Roster receipt sync failed:', error);
      return NextResponse.json({ error: 'Roster sync unavailable' }, { status: 503 });
    }
  }
  const { workers } = await fetchWorkersForSync(since);
  return NextResponse.json({ workers, synced_at: lastSync });
}
