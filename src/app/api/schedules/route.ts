export const dynamic = 'force-dynamic';
import { ConvexError } from 'convex/values';
import { NextRequest, NextResponse } from 'next/server';
import convex from '@/lib/convex';
import { api } from '../../../../convex/_generated/api';
import { isValidScheduleName, parseScheduleDays, SCHEDULE_DAYS_ERROR, SCHEDULE_NAME_ERROR } from '../../../../convex/scheduleValidation';

function scheduleInputError(fields: Record<string, unknown>, creating: boolean): string | null {
  if (creating || fields.name !== undefined) {
    if (!isValidScheduleName(fields.name)) return SCHEDULE_NAME_ERROR;
  }
  if (creating || fields.days !== undefined) {
    const days = fields.days;
    if (!parseScheduleDays(typeof days === 'string' ? days : JSON.stringify(days))) return SCHEDULE_DAYS_ERROR;
  }
  for (const key of ['start_time', 'end_time'] as const) {
    if ((creating || fields[key] !== undefined) && typeof fields[key] !== 'string') return `${key} must be an HH:MM time.`;
  }
  if (fields.department !== undefined && fields.department !== null && typeof fields.department !== 'string') {
    return 'department must be a string or null.';
  }
  return null;
}

function badScheduleInput(error: unknown): string | null {
  if (error instanceof ConvexError &&
      (error.data?.code === 'INVALID_SCHEDULE' || error.data?.code === 'INVALID_SCHEDULE_TIMES')) {
    return error.data.message;
  }
  return null;
}

export async function GET() {
  try {
    const schedules = await convex.query(api.schedules.list, {});
    return NextResponse.json(schedules);
  } catch (error) {
    console.error('Schedules GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch schedules' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const fields = await req.json().catch(() => null);
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return NextResponse.json({ error: 'Invalid schedule request.' }, { status: 400 });
    const inputError = scheduleInputError(fields, true);
    if (inputError) return NextResponse.json({ error: inputError }, { status: 400 });
    const { name, days, start_time, end_time, department } = fields;
    const result = await convex.mutation(api.schedules.create, {
      name: name.trim(),
      days: typeof days === 'string' ? days : JSON.stringify(days),
      startTime: start_time,
      endTime: end_time,
      department: department?.trim() || undefined,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const inputError = badScheduleInput(error);
    if (inputError) return NextResponse.json({ error: inputError }, { status: 400 });
    console.error('Schedules POST error:', error);
    return NextResponse.json({ error: 'Failed to create schedule' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const fields = await req.json().catch(() => null);
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return NextResponse.json({ error: 'Invalid schedule request.' }, { status: 400 });
    const { id, name, days, start_time, end_time, department } = fields;
    if (typeof id !== 'string' || !id) return NextResponse.json({ error: 'id required' }, { status: 400 });
    const inputError = scheduleInputError(fields, false);
    if (inputError) return NextResponse.json({ error: inputError }, { status: 400 });

    const updates: Record<string, unknown> = { id };
    if (name !== undefined) updates.name = name.trim();
    if (days !== undefined) updates.days = typeof days === 'string' ? days : JSON.stringify(days);
    if (start_time !== undefined) updates.startTime = start_time;
    if (end_time !== undefined) updates.endTime = end_time;
    if (department !== undefined) updates.department = typeof department === 'string' ? department.trim() : department;

    await convex.mutation(api.schedules.update, updates as any);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const inputError = badScheduleInput(error);
    if (inputError) return NextResponse.json({ error: inputError }, { status: 400 });
    console.error('Schedules PATCH error:', error);
    return NextResponse.json({ error: 'Failed to update schedule' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
    await convex.mutation(api.schedules.remove, { id: id as any });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Schedules DELETE error:', error);
    return NextResponse.json({ error: 'Failed to delete schedule' }, { status: 500 });
  }
}
