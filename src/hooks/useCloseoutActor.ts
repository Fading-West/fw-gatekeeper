'use client';
import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';

// The server independently authorizes writes. This scopes recovery to its actor.
export function useCloseoutActor(): string | undefined {
  const member = useQuery(api.portalMembers.current, {});
  return member?.userId ? String(member.userId) : undefined;
}
