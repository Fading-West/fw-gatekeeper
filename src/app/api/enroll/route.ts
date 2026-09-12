export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import convex from '@/lib/convex';
import { api } from '../../../../convex/_generated/api';
import { getEncodingValidationMessage, isSupportedEncoding } from '@/lib/encoding';
import { hasValidPortalSession } from '@/lib/portal-auth';
import { unauthorizedApiResponse } from '@/lib/auth';
import { findEmployeeDirectoryById } from '@/lib/employee-directory';

export async function POST(req: NextRequest) {
  const isAdminSession = await hasValidPortalSession(req, ['admin']);
  if (!isAdminSession && !(await hasValidPortalSession(req, ['enrollment']))) {
    return unauthorizedApiResponse();
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { name, employeeId, department, photos, workerId, consent } = body as {
      name?: string;
      employeeId?: string;
      department?: string;
      photos?: string[];
      workerId?: string;
      consent?: boolean;
    };

    // Biometric consent must be acknowledged on every enrollment and
    // re-enrollment before any photo is processed. See RETENTION.md.
    if (consent !== true) {
      return NextResponse.json(
        { error: 'Biometric consent must be confirmed before enrolling a face.' },
        { status: 400 },
      );
    }

    let normalizedName = name?.trim();
    let employeeIdForSave = employeeId?.trim() || undefined;
    let departmentForSave = department?.trim() || undefined;

    if (workerId && !isAdminSession) {
      const existingForEnrollment = await convex.query(api.workers.get, { id: workerId as any });
      if (!existingForEnrollment) return NextResponse.json({ error: 'Worker not found' }, { status: 404 });
      normalizedName = existingForEnrollment.name;
      employeeIdForSave = existingForEnrollment.employee_id || undefined;
      departmentForSave = existingForEnrollment.department || undefined;
    } else if (!isAdminSession) {
      const rosterEmployee = findEmployeeDirectoryById(employeeIdForSave);
      if (!rosterEmployee) {
        return NextResponse.json(
          { error: 'Select an employee from the company roster before enrolling.' },
          { status: 403 },
        );
      }
      normalizedName = rosterEmployee.name;
      employeeIdForSave = rosterEmployee.employeeId;
      departmentForSave = rosterEmployee.department;
    }

    if (!normalizedName) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    }

    if (!Array.isArray(photos) || photos.length < 3 || photos.length > 6 ||
        photos.some((photo) => typeof photo !== 'string' || photo.length === 0 || photo.length > 4_000_000)) {
      return NextResponse.json(
        { error: 'Provide 3 to 6 photos, each no larger than 4 MB, for enrollment' },
        { status: 400 }
      );
    }

    const existingWorker = await convex.query(api.workers.findByName, { name: normalizedName });
    if (existingWorker?.active && (!workerId || existingWorker.id !== workerId)) {
      return NextResponse.json({ error: 'Worker name already exists' }, { status: 409 });
    }
    if (employeeIdForSave) {
      const existingEmployeeId = await convex.query(api.workers.findByEmployeeId, { employeeId: employeeIdForSave });
      if (existingEmployeeId?.active && (!workerId || existingEmployeeId.id !== workerId)) {
        return NextResponse.json(
          { error: `Employee ID ${employeeIdForSave} is already enrolled for ${existingEmployeeId.name}` },
          { status: 409 },
        );
      }
    }

    let faceEncoding: number[] | undefined;
    let acceptedPhotos = photos;
    try {
      const encodeUrl = process.env.FACE_ENCODE_URL || 'http://localhost:5557/encode';
      const faceServiceKey = process.env.FACE_SERVICE_KEY?.trim();
      if (!faceServiceKey) {
        throw new Error('FACE_SERVICE_KEY is required for face enrollment');
      }
      const encodeRes = await fetch(encodeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-face-service-key': faceServiceKey,
        },
        body: JSON.stringify({ photos }),
        signal: AbortSignal.timeout(60000), // 60s — face service cold start + encoding
      });
      const encodeBody = await encodeRes.json();
      if (encodeRes.ok) {
        faceEncoding = encodeBody.encoding;
        if (!Array.isArray(encodeBody.used_photo_indexes)) {
          throw new Error('Face service must support enrollment quality before accepting photos');
        }
        {
          const indexes = encodeBody.used_photo_indexes;
          if (indexes.length < 2 || new Set(indexes).size !== indexes.length ||
              indexes.some((index: unknown) => typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= photos.length)) {
            throw new Error('Face service returned invalid accepted photo indexes');
          }
          acceptedPhotos = indexes.map((index: number) => photos[index]);
        }
      } else {
        // The face service's quality gate returns 422 with a structured detail
        // ({ message, photos, disagreeing_pairs }); other failures use a string detail.
        const detail = encodeBody?.detail;
        const qualityDetail = detail && typeof detail === 'object' && !Array.isArray(detail) ? detail : null;
        const detailMessage = typeof detail === 'string' ? detail : undefined;
        return NextResponse.json(
          {
            error:
              qualityDetail?.message ||
              detailMessage ||
              encodeBody?.error ||
              'Face encoding service rejected the enrollment photos',
            ...(qualityDetail
              ? {
                  photos: Array.isArray(qualityDetail.photos) ? qualityDetail.photos : [],
                  disagreeing_pairs: Array.isArray(qualityDetail.disagreeing_pairs) ? qualityDetail.disagreeing_pairs : [],
                }
              : {}),
          },
          { status: encodeRes.status === 422 ? 422 : 503 }
        );
      }
    } catch (encodeErr) {
      console.error('Face encoding failed:', encodeErr);
      return NextResponse.json(
        { error: 'Face encoding service is unavailable. Worker was not created.' },
        { status: 503 }
      );
    }

    if (!isSupportedEncoding(faceEncoding)) {
      return NextResponse.json({ error: getEncodingValidationMessage('Face encoding') }, { status: 422 });
    }

    const storageIds: string[] = [];
    // Store only frames the quality gate used for the reference encoding.
    // A rejected/outlier frame must not become the worker's dashboard photo.
    for (const photo of acceptedPhotos) {
      try {
        const uploadUrl = await convex.mutation(api.workers.generateUploadUrl, {});
        const base64Data = photo.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        const blob = new Blob([buffer], { type: 'image/jpeg' });

        const uploadRes = await fetch(uploadUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'image/jpeg' },
          body: blob,
        });

        if (uploadRes.ok) {
          const { storageId } = await uploadRes.json();
          storageIds.push(storageId);
        }
      } catch (uploadErr) {
        console.error('Failed to upload photo:', uploadErr);
      }
    }

    const now = new Date().toISOString();
    const consentAt = now;
    const result = workerId
      ? await convex.mutation(api.workers.update, {
          id: workerId as any,
          name: normalizedName,
          employeeId: employeeIdForSave,
          department: departmentForSave,
          faceEncoding,
          photoStorageIds: storageIds.length > 0 ? storageIds as any : undefined,
          enrolledAt: now,
          consentAt,
        })
      : isAdminSession
        ? await convex.mutation(api.workers.create, {
            name: normalizedName,
            employeeId: employeeIdForSave,
            department: departmentForSave,
            faceEncoding,
            photoStorageIds: storageIds.length > 0 ? storageIds as any : undefined,
            consentAt,
          })
        : await convex.mutation(api.workers.createFromRoster, {
            employeeId: employeeIdForSave!,
            faceEncoding,
            photoStorageIds: storageIds.length > 0 ? storageIds as any : undefined,
            consentAt,
          });

    return NextResponse.json(
      {
        id: workerId || (result as any).id,
        name: normalizedName,
        photosCount: storageIds.length,
        encoded: true,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('Enrollment error:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
