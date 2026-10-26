import { NextRequest } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';
import convex from '@/lib/convex';
import { hasValidPortalSession } from '@/lib/portal-auth';
import { GET } from './route';
import { ATTENDANCE_SCOPE } from '@/lib/attendance-comparison';

vi.mock('@/lib/convex', () => ({ default: { query: vi.fn(), mutation: vi.fn() } }));
vi.mock('@/lib/portal-auth', () => ({ hasValidPortalSession: vi.fn() }));
const req = () => new NextRequest('https://example.test/api/shift-closeout?date=2026-09-02');
const signed = { version: 1, digest: 'a'.repeat(64), raw_punches: 2, corrections: 0, reversals: 0 };
const comparison = { status: 'unchanged', scope: ATTENDANCE_SCOPE, compared_at: '2026-09-03T01:00:00Z', signed, current: signed };

beforeEach(() => { vi.clearAllMocks(); vi.mocked(hasValidPortalSession).mockResolvedValue(true); });

it('exposes validated equality and safely degrades legacy/malformed responses', async () => {
  for (const value of [comparison, undefined, { ...comparison, signed: { ...signed, version: 2 } }, { ...comparison, current: { ...signed, digest: 'b'.repeat(64) } }]) {
    vi.mocked(convex.query).mockResolvedValue({ date: '2026-09-02', closeout: { status: 'completed', notes: 'Preserved' }, attendance_comparison: value });
    const response = await GET(req());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.closeout.notes).toBe('Preserved');
    expect(body.attendance_comparison.status).toBe(value === comparison ? 'unchanged' : 'unknown');
  }
  expect(convex.mutation).not.toHaveBeenCalled();
});

it('returns unknown for a missing function and failure rather than false equality', async () => {
  vi.mocked(convex.query).mockRejectedValueOnce(new Error('FunctionPathNotFound'));
  const fallback = await (await GET(req())).json();
  expect(fallback).toMatchObject({ backend_unavailable: true, can_complete: false, attendance_comparison: { status: 'unknown' } });
  vi.mocked(convex.query).mockRejectedValueOnce(new Error('connection interrupted'));
  const failed = await GET(req());
  expect(failed.status).toBe(500);
  expect(await failed.json()).not.toHaveProperty('attendance_comparison');
});

it('keeps all reads authenticated for the existing roles', async () => {
  vi.mocked(hasValidPortalSession).mockResolvedValue(false);
  expect((await GET(req())).status).toBe(401);
  expect(convex.query).not.toHaveBeenCalled();
  expect(hasValidPortalSession).toHaveBeenCalledWith(expect.any(NextRequest), ['admin', 'enrollment', 'viewer']);
});
