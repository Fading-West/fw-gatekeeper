export const dynamic = 'force-dynamic';
import { ConvexError } from 'convex/values';
import { NextRequest, NextResponse } from 'next/server';
import convex from '@/lib/convex';
import { api } from '../../../../convex/_generated/api';
import { hasValidPortalSession } from '@/lib/portal-auth';
import { unauthorizedApiResponse } from '@/lib/auth';

async function requireAdmin(req: NextRequest) {
  return (await hasValidPortalSession(req, ['admin'])) ? null : unauthorizedApiResponse();
}

export async function GET(req: NextRequest) {
  if (!(await hasValidPortalSession(req, ['admin', 'enrollment', 'viewer']))) return unauthorizedApiResponse();
  try {
    return NextResponse.json(await convex.query(api.kiosks.list, {}));
  } catch (error) {
    console.error('Kiosks GET error:', error);
    return NextResponse.json({ error: 'Failed to load kiosks' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;

  const body = await req.json();
  const { name, kiosk_id, kioskId, type, location } = body;
  if (!name || !type) return NextResponse.json({ error: 'name and type required' }, { status: 400 });
  if (type !== 'entry' && type !== 'exit') {
    return NextResponse.json({ error: 'type must be entry or exit' }, { status: 400 });
  }

  try {
    const result = await convex.mutation(api.kiosks.create, {
      name,
      kioskId: kiosk_id || kioskId || undefined,
      type,
      location: location || undefined,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof ConvexError) {
      const status = error.data?.code === 'KIOSK_IDENTIFIER_CONFLICT' ? 409
        : ['INVALID_KIOSK_NAME', 'KIOSK_FLEET_LIMIT'].includes(error.data?.code) ? 400 : null;
      if (status) return NextResponse.json({ error: error.data.message }, { status });
    }
    console.error('Kiosks POST error:', error);
    return NextResponse.json({ error: 'Failed to register kiosk' }, { status: 500 });
  }
}
