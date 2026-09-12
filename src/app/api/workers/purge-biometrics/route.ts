export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import convex from '@/lib/convex';
import { api } from '../../../../../convex/_generated/api';
import { hasValidPortalSession } from '@/lib/portal-auth';
import { unauthorizedApiResponse } from '@/lib/auth';

// Admin-only: permanently deletes a worker's face template and enrollment
// photos, deactivates the worker so kiosks drop the cached template on their
// next sync, and writes an audit row. See RETENTION.md.
export async function POST(req: NextRequest) {
  if (!(await hasValidPortalSession(req, ['admin']))) {
    return unauthorizedApiResponse();
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'A JSON object is required' }, { status: 400 });
  const { id, reason } = body as { id?: string; reason?: string };
  const trimmedReason = typeof reason === 'string' ? reason.trim() : '';

  if (typeof id !== 'string' || !id.trim()) return NextResponse.json({ error: 'ID required' }, { status: 400 });
  if (!trimmedReason) return NextResponse.json({ error: 'A reason is required to purge face data' }, { status: 400 });

  try {
    const result = await convex.mutation(api.workers.purgeBiometrics, { id: id as any, reason: trimmedReason });
    return NextResponse.json(result);
  } catch (error) {
    console.error('Biometric purge failed:', error);
    const message = error instanceof Error ? error.message : 'Failed to purge face data';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
