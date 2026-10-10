'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useConvexAuth, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import Sidebar from './Sidebar';
import GuideDrawer from './GuideDrawer';

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const member = useQuery(api.portalMembers.current, isAuthenticated ? {} : 'skip');
  const isLogin = pathname === '/login';
  const isPasswordChange = pathname === '/change-password';

  useEffect(() => {
    if (member?.mustChangePassword && !isPasswordChange) router.replace('/change-password');
  }, [member?.mustChangePassword, isPasswordChange, router]);

  // Do not mount protected page queries while identity/rotation is unresolved.
  if (!isPasswordChange && !isLogin && (isLoading || (isAuthenticated && member === undefined) || member?.mustChangePassword)) {
    return <div className="min-h-screen bg-navy-950 p-8 text-slate-300">Loading account…</div>;
  }

  if (isLogin || isPasswordChange) {
    return <>{children}</>;
  }

  return (
    <>
      <Sidebar />
      <main className="md:ml-[260px] min-h-screen pb-[calc(7rem+env(safe-area-inset-bottom))] pt-16 md:pb-0 md:pt-0">
        <div className="max-w-7xl mx-auto px-4 py-6 md:px-8 md:py-8">{children}</div>
      </main>
      <GuideDrawer />
    </>
  );
}
