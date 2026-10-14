export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import convex from '@/lib/convex';
import { api } from '../../../../convex/_generated/api';
import { getEncodingValidationMessage, isSupportedEncoding } from '@/lib/encoding';
import { hasValidPortalSession } from '@/lib/portal-auth';
import { unauthorizedApiResponse } from '@/lib/auth';
import { ConvexError } from 'convex/values';

async function requireAdmin(req: NextRequest) {
  return (await hasValidPortalSession(req, ['admin'])) ? null : unauthorizedApiResponse();
}

async function requireWorkerRead(req: NextRequest) {
  return (await hasValidPortalSession(req, ['admin', 'enrollment'])) ? null : unauthorizedApiResponse();
}

async function requireDashboardWorkerRead(req: NextRequest) {
  return (await hasValidPortalSession(req, ['admin', 'enrollment', 'viewer'])) ? null : unauthorizedApiResponse();
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id');
  if (id) {
    const unauthorized = await requireWorkerRead(req);
    if (unauthorized) return unauthorized;

    const worker = await convex.query(api.workers.get, { id: id as any });
    if (!worker) return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
    return NextResponse.json({
      id: worker.id,
      name: worker.name,
      employee_id: worker.employee_id,
      identity_revision: worker.identity_revision,
      department: worker.department,
      photo_url: worker.photo_url,
      has_face_encoding: worker.has_face_encoding,
      encoding_status: worker.encoding_status,
      enrolled_at: worker.enrolled_at,
      active: worker.active,
    });
  }

  const dashboardScope = req.nextUrl.searchParams.get('scope') === 'dashboard';
  if (dashboardScope) {
    const unauthorized = await requireDashboardWorkerRead(req);
    if (unauthorized) return unauthorized;

    const workers = await convex.query(api.workers.list, { includeEncodings: false });
    return NextResponse.json(workers.map((worker: any) => ({
      id: worker.id,
      name: worker.name,
      employee_id: worker.employee_id,
      department: worker.department,
      photo_url: worker.photo_url,
      has_face_encoding: worker.has_face_encoding,
      encoding_status: worker.encoding_status,
      enrolled_at: worker.enrolled_at,
      active: worker.active,
    })));
  }

  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;

  const workers = await convex.query(api.workers.list, { includeEncodings: false, active: req.nextUrl.searchParams.get('active') !== 'false' });
  return NextResponse.json(workers.map((worker: any) => ({
    id: worker.id,
    name: worker.name,
    employee_id: worker.employee_id,
    identity_revision: worker.identity_revision,
    department: worker.department,
    photo_url: worker.photo_url,
    has_face_encoding: worker.has_face_encoding,
    encoding_status: worker.encoding_status,
    enrolled_at: worker.enrolled_at,
    active: worker.active,
  })));
}

export async function PATCH(req: NextRequest) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;

  try {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'A JSON object is required' }, { status: 400 });
  const { id, name, employee_id, department, face_encoding, expected_identity_revision } = body;

  if (!id) return NextResponse.json({ error: 'ID required' }, { status: 400 });
  if (face_encoding !== undefined && !isSupportedEncoding(face_encoding)) {
    return NextResponse.json({ error: getEncodingValidationMessage('face_encoding') }, { status: 400 });
  }

  const updates: Record<string, unknown> = { id };
  if (name !== undefined || employee_id !== undefined || department !== undefined) {
    if (typeof expected_identity_revision !== 'string') return NextResponse.json({ error: 'Reload the worker before changing identity fields.', code: 'WORKER_IDENTITY_CONFLICT' }, { status: 409 });
    updates.expectedIdentityRevision = expected_identity_revision;
  }
  if (name !== undefined) updates.name = name;
  if (employee_id !== undefined) updates.employeeId = employee_id;
  if (department !== undefined) updates.department = department;
  if (face_encoding !== undefined) updates.faceEncoding = face_encoding;

  await convex.mutation(api.workers.update, updates as any);
  return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof ConvexError && typeof error.data === 'object' && error.data?.code === 'WORKER_IDENTITY_CONFLICT') {
      return NextResponse.json({ error: error.data.message, code: error.data.code }, { status: 409 });
    }
    return NextResponse.json({ error: 'Failed to update worker' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;

  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'ID required' }, { status: 400 });

  await convex.mutation(api.workers.remove, { id: id as any });
  return NextResponse.json({ ok: true });
}
