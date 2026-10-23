import { createHash, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

function getKioskApiKey(): string {
  return process.env.KIOSK_API_KEY?.trim() || '';
}

export function presentedKioskKey(req: NextRequest): string | null {
  const authHeader = req.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice('Bearer '.length).trim() || null;
  return req.headers.get('x-kiosk-key')?.trim() || null;
}

export function hasDeviceKeyFormat(req: NextRequest): boolean {
  return /^gkdev_[A-Za-z0-9_-]{43}$/.test(presentedKioskKey(req) || '');
}

export function hasValidKioskKey(req: NextRequest): boolean {
  const configuredKey = getKioskApiKey();
  if (!configuredKey) {
    // Fail closed. A missing key must never mean "trust everyone", regardless
    // of NODE_ENV. Local development can opt in explicitly.
    return process.env.FW_ALLOW_UNCONFIGURED_KIOSK_KEY === 'true' && process.env.NODE_ENV !== 'production';
  }

  // Next.js Proxy and the API routes run on Node.js. Hash both keys so the
  // constant-time comparison always receives equal-length buffers.
  const configuredDigest = createHash('sha256').update(configuredKey).digest();
  const matchesKey = (key: string | null): boolean => key !== null &&
    timingSafeEqual(createHash('sha256').update(key).digest(), configuredDigest);

  const authHeader = req.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ') && matchesKey(authHeader.slice('Bearer '.length).trim())) {
    return true;
  }

  return matchesKey(req.headers.get('x-kiosk-key'));
}

export function unauthorizedApiResponse(message = 'Unauthorized'): NextResponse {
  return NextResponse.json({ error: message }, { status: 401 });
}

export function isKioskRequestAllowed(req: NextRequest): boolean {
  const { pathname } = req.nextUrl;

  return (
    (pathname === '/api/sync' && req.method === 'GET') ||
    (pathname === '/api/sync/ack' && req.method === 'POST') ||
    (pathname === '/api/attendance' && req.method === 'POST') ||
    (pathname === '/api/attendance/bulk' && req.method === 'POST') ||
    (pathname === '/api/recognition-attempts/bulk' && req.method === 'POST')
  );
}
