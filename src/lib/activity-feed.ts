import 'server-only';

const ACTIVITY_TIMEOUT_MS = 10_000;

export class ActivityBackendError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
    this.name = 'ActivityBackendError';
  }
}

function getConvexActivityBaseUrl() {
  const configuredUrl = process.env.CONVEX_INGEST_URL?.trim();
  if (configuredUrl) return configuredUrl.replace(/\/$/, '');
  const deploymentUrl = process.env.NEXT_PUBLIC_CONVEX_URL?.trim();
  if (!deploymentUrl) throw new ActivityBackendError('Convex activity backend is not configured.', 503);
  return deploymentUrl.replace(/\.convex\.cloud\/?$/, '.convex.site');
}

export async function fetchActivityFeed(authorization: string | null) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ACTIVITY_TIMEOUT_MS);
  try {
    const response = await fetch(`${getConvexActivityBaseUrl()}/api/internal/activity`, {
      method: 'GET',
      headers: authorization ? { authorization } : undefined,
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    });
    const body = await response.text();
    return { body, status: response.status, contentType: response.headers.get('content-type') };
  } catch (error) {
    if (error instanceof ActivityBackendError) throw error;
    const reason = error instanceof Error && error.name === 'AbortError' ? 'timed out' : 'failed';
    throw new ActivityBackendError(`Convex activity backend ${reason}.`);
  } finally {
    clearTimeout(timeout);
  }
}
