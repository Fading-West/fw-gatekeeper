import { ConvexError } from 'convex/values';
import { NextRequest } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';
import convex from '@/lib/convex';
import { POST, PATCH } from './route';
import { SCHEDULE_TIME_ERROR } from '../../../../convex/scheduleTimes';

vi.mock('@/lib/convex', () => ({ default: { mutation: vi.fn() } }));
beforeEach(() => vi.clearAllMocks());

it.each(['POST', 'PATCH'])('returns a useful 400 for invalid schedule times on %s', async method => {
  vi.mocked(convex.mutation).mockRejectedValue(new ConvexError({ code: 'INVALID_SCHEDULE_TIMES', message: SCHEDULE_TIME_ERROR }));
  const handler = method === 'POST' ? POST : PATCH;
  const response = await handler(new NextRequest('https://gateway.example.test/api/schedules', {
    method, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'schedule', name: 'Night', days: [1], start_time: '22:00', end_time: '06:00' }),
  }));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: SCHEDULE_TIME_ERROR });
});
