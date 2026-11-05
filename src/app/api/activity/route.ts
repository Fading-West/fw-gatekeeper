export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { ActivityBackendError, fetchActivityFeed } from '@/lib/activity-feed';

const RESPONSE_HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'private, no-store',
};

export async function GET(request: NextRequest) {
  try {
    const result = await fetchActivityFeed(request.headers.get('authorization'));
    const mediaType = result.contentType?.split(';', 1)[0].trim().toLowerCase();
    if (mediaType !== 'application/json') {
      throw new ActivityBackendError('Convex activity backend returned a non-JSON response.');
    }
    try {
      JSON.parse(result.body);
    } catch {
      throw new ActivityBackendError('Convex activity backend returned invalid JSON.');
    }
    return new Response(result.body, {
      status: result.status,
      headers: RESPONSE_HEADERS,
    });
  } catch (error) {
    const status = error instanceof ActivityBackendError ? error.status : 502;
    console.error('activity_feed_backend_unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json({ error: 'Activity feed unavailable' }, { status, headers: RESPONSE_HEADERS });
  }
}
