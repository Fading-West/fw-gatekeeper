import { ConvexHttpClient } from 'convex/browser';
import { api } from '../../convex/_generated/api';

export type PortalMemberRole = 'admin' | 'enrollment' | 'viewer';

export type PortalMember = {
  userId: string;
  role: PortalMemberRole;
  active: boolean;
  mustChangePassword?: boolean;
};

export async function getPortalMemberForToken(token?: string): Promise<PortalMember | null> {
  if (!token) {
    return null;
  }

  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    return null;
  }

  const client = new ConvexHttpClient(convexUrl);
  client.setAuth(token);

  try {
    return await client.query(api.portalMembers.current, {});
  } catch {
    return null;
  }
}

export async function hasPortalMemberAccess(
  token?: string,
  allowedRoles: PortalMemberRole[] = ['admin', 'enrollment', 'viewer'],
): Promise<boolean> {
  const member = await getPortalMemberForToken(token);
  return Boolean(member && member.active && !member.mustChangePassword && allowedRoles.includes(member.role));
}
