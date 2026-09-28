import { NextRequest, NextResponse } from 'next/server';
import { hasDeviceKeyFormat, unauthorizedApiResponse } from '@/lib/auth';
import { authenticateKiosk } from '@/lib/kiosk-device-auth';
import { acknowledgeRosterReceipt } from '@/lib/convex-ingest';

export async function POST(req: NextRequest) {
  if (!hasDeviceKeyFormat(req)) return unauthorizedApiResponse();
  const body = await req.json().catch(() => null);
  if (!body || typeof body.kiosk_id !== 'string' || !body.kiosk_id.trim() ||
      typeof body.roster_receipt !== 'string' || !body.roster_receipt.trim()) {
    return NextResponse.json({ error: 'kiosk_id and roster_receipt required' }, { status: 400 });
  }
  const identity = await authenticateKiosk(req, [body.kiosk_id]);
  if (!identity) return unauthorizedApiResponse();
  try {
    const result = await acknowledgeRosterReceipt(identity.documentId, body.roster_receipt);
    return result.acknowledged
      ? NextResponse.json({ acknowledged: true, applied_at: result.appliedAt })
      : NextResponse.json({ error: 'Roster receipt was not acknowledged' }, { status: 409 });
  } catch (error) {
    console.error('Roster acknowledgement failed:', error);
    return NextResponse.json({ error: 'Roster acknowledgement unavailable' }, { status: 503 });
  }
}
