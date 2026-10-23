import { NextRequest, type NextFetchEvent } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPortalMemberForToken } from '@/lib/portal-member';
import { proxy } from './proxy';

vi.mock('@/lib/portal-member', () => ({ getPortalMemberForToken: vi.fn() }));
vi.mock('@convex-dev/auth/nextjs/server', () => ({
  convexAuthNextjsMiddleware: (handler: (req: NextRequest, ctx: unknown) => unknown) =>
    (req: NextRequest) => handler(req, { convexAuth: { getToken: async () => 'session-token' } }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPortalMemberForToken).mockResolvedValue({ userId: 'user', role: 'admin', active: true, mustChangePassword: true });
});
const run = async (path: string, headers?: Record<string, string>) => {
  const response = await proxy(new NextRequest(`https://portal.example${path}`, { headers }), {} as NextFetchEvent);
  if (!response) throw new Error('Expected middleware response');
  return response;
};

describe('password rotation middleware', () => {
  it.each(['/', '/accounts', '/kiosks', '/workers', '/enroll', '/schedules'])('redirects %s to the change form', async path => {
    const response = await run(path);
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://portal.example/change-password');
  });
  it('allows the change form and authentication endpoints', async () => {
    for (const path of ['/change-password', '/login', '/api/convex-auth']) {
      expect((await run(path)).headers.get('x-middleware-next')).toBe('1');
    }
  });
  it.each(['/api/enroll', '/api/workers', '/api/employee-directory', '/api/system-health', '/api/sync'])('denies %s with a distinguishable code', async path => {
    const response = await run(path, { authorization: `Bearer gkdev_${'a'.repeat(43)}` });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'PASSWORD_CHANGE_REQUIRED' });
  });
  it('preserves access for existing members without the flag', async () => {
    vi.mocked(getPortalMemberForToken).mockResolvedValue({ userId: 'user', role: 'admin', active: true });
    expect((await run('/accounts')).headers.get('x-middleware-next')).toBe('1');
    expect((await run('/api/workers')).headers.get('x-middleware-next')).toBe('1');
  });
  it('redirects an invalid session away from the change form', async () => {
    vi.mocked(getPortalMemberForToken).mockResolvedValue(null);
    expect((await run('/change-password')).headers.get('location')).toBe('https://portal.example/login');
  });
  it('preserves role restrictions for unflagged viewers', async () => {
    vi.mocked(getPortalMemberForToken).mockResolvedValue({ userId: 'user', role: 'viewer', active: true, mustChangePassword: false });
    expect((await run('/kiosks')).headers.get('location')).toBe('https://portal.example/');
    expect((await run('/api/workers')).status).toBe(401);
    expect((await run('/api/stats')).headers.get('x-middleware-next')).toBe('1');
  });
});
