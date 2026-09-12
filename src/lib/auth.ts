import { NextRequest, NextResponse } from 'next/server';

function getKioskApiKey(): string {
  return process.env.KIOSK_API_KEY?.trim() || '';
}

export function hasValidKioskKey(req: NextRequest): boolean {
  const configuredKey = getKioskApiKey();
  if (!configuredKey) {
    // Fail closed. A missing key must never mean "trust everyone", regardless
    // of NODE_ENV. Local development can opt in explicitly.
    return process.env.FW_ALLOW_UNCONFIGURED_KIOSK_KEY === 'true' && process.env.NODE_ENV !== 'production';
  }

  const authHeader = req.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ') && authHeader.slice('Bearer '.length).trim() === configuredKey) {
    return true;
  }

  return req.headers.get('x-kiosk-key') === configuredKey;
}

export function unauthorizedApiResponse(message = 'Unauthorized'): NextResponse {
  return NextResponse.json({ error: message }, { status: 401 });
}

export function isKioskRequestAllowed(req: NextRequest): boolean {
  const { pathname } = req.nextUrl;

  return (
    (pathname === '/api/sync' && req.method === 'GET') ||
    (pathname === '/api/attendance' && req.method === 'POST') ||
    (pathname === '/api/attendance/bulk' && req.method === 'POST') ||
    (pathname === '/api/recognition-attempts/bulk' && req.method === 'POST')
  );
}
