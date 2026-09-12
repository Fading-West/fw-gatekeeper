export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../../../../convex/_generated/api';

// Render's health check, external uptime monitors, and every kiosk's
// `check_server()` (pi-kiosk/sync.py, 5 s timeout) all hit this route, so it
// must stay cheap: one tiny unauthenticated Convex query, hard-capped at 5 s.
// Do not add caching that would hide a Convex outage for more than ~10 s,
// otherwise a monitor would keep reporting "ok" while the database is down.
const CONVEX_TIMEOUT_MS = 5000;

function describeError(error: unknown) {
  if (error instanceof Error) {
    return error.name === 'AbortError' ? `Convex ping timed out after ${CONVEX_TIMEOUT_MS}ms` : error.message;
  }
  return String(error);
}

export async function GET() {
  const timestamp = new Date().toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONVEX_TIMEOUT_MS);

  try {
    const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
    if (!convexUrl) {
      throw new Error('NEXT_PUBLIC_CONVEX_URL is not set');
    }

    // Plain client with no user token: `health.ping` is public by design.
    const client = new ConvexHttpClient(convexUrl, {
      fetch: (input, init) => fetch(input, { ...init, cache: 'no-store', signal: controller.signal }),
    });
    const result = await client.query(api.health.ping, {});
    if (!result?.ok) {
      throw new Error('Convex ping returned an unexpected payload');
    }

    return NextResponse.json({ status: 'ok', convex: 'ok', timestamp });
  } catch (error) {
    const message = describeError(error);
    console.error('health_convex_unreachable', { error: message });
    return NextResponse.json(
      { status: 'degraded', convex: 'unreachable', timestamp },
      { status: 503 },
    );
  } finally {
    clearTimeout(timeout);
  }
}
