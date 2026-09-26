import { NextRequest, NextResponse } from 'next/server';
import { hasValidKioskKey, unauthorizedApiResponse } from '@/lib/auth';
import { acknowledgeRosterReceipt } from '@/lib/convex-ingest';

export async function POST(req: NextRequest) {
  if (!hasValidKioskKey(req)) return unauthorizedApiResponse();
  const body = await req.json().catch(() => null);
  if (!body || typeof body.kiosk_id !== 'string' || typeof body.roster_receipt !== 'string') {
    return NextResponse.json({ error: 'kiosk_id and roster_receipt required' }, { status: 400 });
  }
  try {
    const result = await acknowledgeRosterReceipt(body.kiosk_id, body.roster_receipt);
    return result.acknowledged
      ? NextResponse.json({ acknowledged: true, applied_at: result.appliedAt })
      : NextResponse.json({ error: 'Roster receipt was not acknowledged' }, { status: 409 });
  } catch (error) {
    console.error('Roster acknowledgement failed:', error);
    return NextResponse.json({ error: 'Roster acknowledgement unavailable' }, { status: 503 });
  }
}
