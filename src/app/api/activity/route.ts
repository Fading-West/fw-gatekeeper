export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { ActivityBackendError, fetchActivityFeed } from '@/lib/activity-feed';

const RESPONSE_HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
};

export async function GET(request: NextRequest) {
  try {
    const result = await fetchActivityFeed(request.headers.get('authorization'));
    return new Response(result.body, {
      status: result.status,
      headers: {
        ...RESPONSE_HEADERS,
        ...(result.contentType?.includes('application/json') ? {} : { 'x-fw-upstream-content-type-invalid': 'true' }),
      },
    });
  } catch (error) {
    const status = error instanceof ActivityBackendError ? error.status : 502;
    console.error('activity_feed_backend_unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json({ error: 'Activity feed unavailable' }, { status, headers: RESPONSE_HEADERS });
  }
}
