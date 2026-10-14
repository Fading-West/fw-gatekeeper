import { ConvexHttpClient } from 'convex/browser';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPortalMemberForToken, hasPortalMemberAccess } from './portal-member';
import { hasValidPortalSession } from './portal-auth';
import { GET } from '@/app/api/employee-directory/route';
import convex from './convex';

const { query, setAuth } = vi.hoisted(() => ({ query: vi.fn(), setAuth: vi.fn() }));
vi.mock('convex/browser', () => ({ ConvexHttpClient: vi.fn(class { query = query; setAuth = setAuth; }) }));
vi.mock('server-only', () => ({}));
vi.mock('@convex-dev/auth/nextjs/server', () => ({ convexAuthNextjsToken: vi.fn(async () => 'session-token') }));
vi.mock('./convex', () => ({ default: { query: vi.fn() } }));
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'https://example.convex.cloud'); });
afterEach(() => vi.unstubAllEnvs());

describe('portal API session authorization', () => {
  it('denies a flagged member while keeping the current lookup available for redirects', async () => {
    query.mockResolvedValue({ userId: 'user', role: 'admin', active: true, mustChangePassword: true });
    expect(await getPortalMemberForToken('session-token')).toMatchObject({ mustChangePassword: true });
    expect(await hasPortalMemberAccess('session-token', ['admin'])).toBe(false);
    expect(await hasValidPortalSession(new NextRequest('https://portal.example/api/enroll'), ['admin', 'enrollment'])).toBe(false);
    expect(setAuth).toHaveBeenCalledWith('session-token');
  });
  it('rejects an API call before reading roster data even without middleware', async () => {
    query.mockResolvedValue({ userId: 'user', role: 'enrollment', active: true, mustChangePassword: true });
    const response = await GET(new NextRequest('https://portal.example/api/employee-directory'));
    expect(response.status).toBe(401);
    expect(convex.query).not.toHaveBeenCalled();
  });
  it('allows legacy members without the optional flag and preserves role checks', async () => {
    query.mockResolvedValue({ userId: 'user', role: 'enrollment', active: true });
    expect(await hasPortalMemberAccess('session-token', ['enrollment'])).toBe(true);
    expect(await hasPortalMemberAccess('session-token', ['admin'])).toBe(false);
  });
  it('fails closed when the session is absent or lookup fails', async () => {
    expect(await hasPortalMemberAccess()).toBe(false);
    expect(ConvexHttpClient).not.toHaveBeenCalled();
    query.mockRejectedValue(new Error('lookup failed'));
    expect(await hasPortalMemberAccess('session-token')).toBe(false);
  });
});
