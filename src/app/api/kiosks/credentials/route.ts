export const dynamic = 'force-dynamic';

import { createHash, randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { ConvexError } from 'convex/values';
import convex from '@/lib/convex';
import { api } from '../../../../../convex/_generated/api';
import { hasValidPortalSession } from '@/lib/portal-auth';
import { unauthorizedApiResponse } from '@/lib/auth';
import type { Id } from '../../../../../convex/_generated/dataModel';

async function adminId(req: NextRequest): Promise<string | null> {
  if (!(await hasValidPortalSession(req, ['admin']))) return null;
  const body = await req.json().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body) && typeof body.id === 'string' && body.id.trim()
    ? body.id.trim() : '';
}

function credentialError(error: unknown) {
  if (error instanceof ConvexError && error.data?.code === 'KIOSK_NOT_FOUND') {
    return NextResponse.json({ error: error.data.message }, { status: 404 });
  }
  return null;
}

export async function POST(req: NextRequest) {
  const id = await adminId(req);
  if (id === null) return unauthorizedApiResponse();
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const credential = `gkdev_${randomBytes(32).toString('base64url')}`;
  const credentialHash = createHash('sha256').update(credential).digest('hex');
  try {
    const result = await convex.mutation(api.kiosks.rotateCredential, { id: id as Id<'kiosks'>, credentialHash });
    return NextResponse.json({ kiosk_id: result.kioskId, credential });
  } catch (error) {
    const known = credentialError(error);
    if (known) return known;
    console.error('Kiosk credential issue failed:', error);
    return NextResponse.json({ error: 'Failed to issue kiosk credential' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!(await hasValidPortalSession(req, ['admin']))) return unauthorizedApiResponse();
  const body = await req.json().catch(() => null);
  const id = body && typeof body === 'object' && !Array.isArray(body) && typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  if (body.confirmStopSync !== true) return NextResponse.json({ error: 'Confirm that this kiosk will stop syncing before revoking access' }, { status: 400 });
  try {
    await convex.mutation(api.kiosks.revokeCredential, { id: id as Id<'kiosks'>, confirmStopSync: true });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const known = credentialError(error);
    if (known) return known;
    console.error('Kiosk credential revoke failed:', error);
    return NextResponse.json({ error: 'Failed to revoke kiosk credential' }, { status: 500 });
  }
}
