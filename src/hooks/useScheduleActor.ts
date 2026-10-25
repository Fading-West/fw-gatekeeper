'use client';

import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';

// Match the actor used by the independently authorized creation receipt.
export function useScheduleActor(): string | undefined {
  const member = useQuery(api.portalMembers.current, {});
  return member?.userId ? String(member.userId) : undefined;
}
