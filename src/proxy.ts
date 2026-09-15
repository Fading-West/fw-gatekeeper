import { convexAuthNextjsMiddleware } from '@convex-dev/auth/nextjs/server';
import { NextFetchEvent, NextRequest, NextResponse } from 'next/server';
import { hasValidKioskKey, isKioskRequestAllowed, unauthorizedApiResponse } from '@/lib/auth';
import { hasPortalMemberAccess, type PortalMemberRole } from '@/lib/portal-member';

// /api/activity has its own dedicated bearer authentication. It must not use
// browser cookies, but the route and its Convex data path both remain protected.
const PUBLIC_PATHS = ['/login', '/api/convex-auth', '/api/health', '/api/activity'];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function getApiAllowedRoles(req: NextRequest): PortalMemberRole[] {
  const { pathname, searchParams } = req.nextUrl;
  const method = req.method.toUpperCase();

  if (pathname === '/api/employee-directory' && method === 'GET') {
    return ['admin', 'enrollment'];
  }

  if (pathname === '/api/enroll') {
    return ['admin', 'enrollment'];
  }

  if (pathname === '/api/workers' && method === 'GET' && searchParams.has('id')) {
    return ['admin', 'enrollment'];
  }

  if (pathname === '/api/workers' && method === 'GET' && searchParams.get('scope') === 'dashboard') {
    return ['admin', 'enrollment', 'viewer'];
  }

  if ((pathname === '/api/stats' || pathname === '/api/attendance' || pathname === '/api/system-health') && method === 'GET') {
    return ['admin', 'enrollment', 'viewer'];
  }

  if (pathname === '/api/recognition-attempts' && method === 'GET') {
    return ['admin', 'enrollment', 'viewer'];
  }

  if (pathname === '/api/recognition-attempts' && method === 'PATCH') {
    return ['admin', 'enrollment'];
  }

  if (pathname === '/api/shift-exceptions' && method === 'GET') {
    return ['admin', 'enrollment', 'viewer'];
  }

  if (pathname === '/api/shift-exceptions' && method === 'PATCH') {
    return ['admin', 'enrollment'];
  }

  if (pathname === '/api/attendance-corrections' && method === 'GET') {
    return ['admin', 'enrollment', 'viewer'];
  }

  if (pathname === '/api/attendance-corrections' && method === 'POST') {
    return ['admin', 'enrollment'];
  }

  if (pathname === '/api/schedules' && method === 'GET') {
    return ['admin', 'enrollment', 'viewer'];
  }

  if (pathname === '/api/shift-briefing' && method === 'GET') {
    return ['admin', 'enrollment', 'viewer'];
  }

  if (pathname === '/api/shift-closeout' && method === 'GET') {
    return ['admin', 'enrollment', 'viewer'];
  }

  if (pathname === '/api/shift-closeout' && method === 'PATCH') {
    return ['admin', 'enrollment'];
  }

  return ['admin'];
}

function isAdminOnlyPage(pathname: string): boolean {
  return pathname === '/kiosks';
}

async function legacyAccessMiddleware(
  req: NextRequest,
  hasConvexPortalMember: boolean,
  hasConvexPortalApiAccess: boolean,
  hasConvexPortalAdmin: boolean,
) {
  const { pathname } = req.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // Allow static assets and Next.js internals
  if (pathname.startsWith('/_next') || pathname.startsWith('/favicon')) {
    return NextResponse.next();
  }

  if (pathname.startsWith('/api/')) {
    if (hasConvexPortalApiAccess) {
      return NextResponse.next();
    }

    if (isKioskRequestAllowed(req) && hasValidKioskKey(req)) {
      return NextResponse.next();
    }

    return unauthorizedApiResponse();
  }

  if (!hasConvexPortalMember) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  if (isAdminOnlyPage(pathname) && !hasConvexPortalAdmin) {
    return NextResponse.redirect(new URL('/', req.url));
  }

  return NextResponse.next();
}

const authenticatedMiddleware = convexAuthNextjsMiddleware(async (req, { convexAuth }) => {
  const token = await convexAuth.getToken();
  const apiAllowedRoles = getApiAllowedRoles(req);
  const hasConvexPortalMember = await hasPortalMemberAccess(token);
  const hasConvexPortalAdmin = await hasPortalMemberAccess(token, ['admin']);
  const hasConvexPortalApiAccess = apiAllowedRoles.join(',') === 'admin'
    ? hasConvexPortalAdmin
    : await hasPortalMemberAccess(token, apiAllowedRoles);
  return legacyAccessMiddleware(req, hasConvexPortalMember, hasConvexPortalApiAccess, hasConvexPortalAdmin);
}, {
  apiRoute: '/api/convex-auth',
});

export function proxy(req: NextRequest, event: NextFetchEvent) {
  return authenticatedMiddleware(req, event);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
