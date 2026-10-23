'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuthActions } from '@convex-dev/auth/react';
import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';

const links = [
  {
    href: '/',
    group: 'Shift',
    label: 'Dashboard',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
      </svg>
    ),
  },
  {
    href: '/briefing',
    group: 'Shift',
    label: 'Briefing',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 4.875A2.625 2.625 0 016.375 2.25h11.25a2.625 2.625 0 012.625 2.625v14.25a2.625 2.625 0 01-2.625 2.625H6.375a2.625 2.625 0 01-2.625-2.625V4.875z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 7.5h7.5M8.25 11.25h7.5M8.25 15h3.75" />
      </svg>
    ),
  },
  {
    href: '/log',
    group: 'Evidence',
    label: 'Activity Log',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
      </svg>
    ),
  },
  {
    href: '/exceptions',
    group: 'Shift',
    label: 'Exceptions',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6h9.75M10.5 12h9.75M10.5 18h9.75M3.75 6h.008v.008H3.75V6zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 6h.008v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 6h.008v.008H3.75V18zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
      </svg>
    ),
  },
  {
    href: '/closeout',
    group: 'Shift',
    label: 'Closeout',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75l2.25 2.25L15.75 9" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 4.5h15v15h-15v-15z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 6.75h7.5M8.25 17.25h7.5" />
      </svg>
    ),
  },
  {
    href: '/workers',
    group: 'Setup',
    label: 'Workers',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
      </svg>
    ),
  },
  {
    href: '/enroll',
    group: 'Setup',
    label: 'Enroll Face',
    // Viewers cannot submit enrollments, so don't advertise the page to them.
    roles: ['admin', 'enrollment'],
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0zM18.75 10.5h.008v.008h-.008V10.5z" />
      </svg>
    ),
  },
  {
    href: '/calibration/recognition',
    group: 'Evidence',
    label: 'Recognition Lab',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 5.25A2.25 2.25 0 016 3h3.75v3H6v3.75H3.75v-4.5zM14.25 3H18a2.25 2.25 0 012.25 2.25v4.5H18V6h-3.75V3zM3.75 14.25H6V18h3.75v3H6A2.25 2.25 0 013.75 18v-3.75zM18 14.25h2.25V18A2.25 2.25 0 0118 20.25h-3.75v-3H18v-3z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75l2.25 2.25L15.75 9" />
      </svg>
    ),
  },
  {
    href: '/accounts',
    group: 'Setup',
    label: 'Accounts',
    adminOnly: true,
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 9h3.75M15 12h3.75M15 15h3.75M4.5 19.5h15a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5h-15A1.5 1.5 0 003 6v12a1.5 1.5 0 001.5 1.5zm0-12.75h15M7.5 12a1.5 1.5 0 100-3 1.5 1.5 0 000 3zm-2.25 4.5a3 3 0 016 0" />
      </svg>
    ),
  },
  {
    href: '/kiosks',
    group: 'Setup',
    label: 'Kiosks',
    adminOnly: true,
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 12V5.25" />
      </svg>
    ),
  },
  {
    href: '/schedules',
    group: 'Setup',
    label: 'Schedules',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
      </svg>
    ),
  },
  {
    href: '/guide',
    group: 'Help',
    label: 'Guide Center',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.75a4.5 4.5 0 00-4.5 4.5v7.5A2.25 2.25 0 009.75 21h4.5a2.25 2.25 0 002.25-2.25v-7.5a4.5 4.5 0 00-4.5-4.5z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 6.75V5.25a3 3 0 016 0v1.5M9.75 12h4.5M9.75 15.75h4.5" />
      </svg>
    ),
  },
];

// The mobile tab bar carries the supervisor loop, not admin setup tasks.
const primaryMobileLinks = ['/', '/exceptions', '/closeout'];
const navGroups = ['Shift', 'Evidence', 'Setup', 'Help'];

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const authActions = useAuthActions();
  const currentMember = useQuery(api.portalMembers.current, {});
  const visibleLinks = links.filter((link) => {
    if (link.adminOnly && currentMember?.role !== 'admin') return false;
    if (link.roles && !link.roles.includes(currentMember?.role ?? '')) return false;
    return true;
  });
  const mobilePrimaryLinks = visibleLinks.filter((link) => primaryMobileLinks.includes(link.href));
  const mobileSecondaryLinks = visibleLinks.filter((link) => !primaryMobileLinks.includes(link.href));
  const currentLink = visibleLinks.find((link) => link.href === pathname);
  const moreIsActive = mobileSecondaryLinks.some((link) => link.href === pathname);
  const [logoutError, setLogoutError] = useState('');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [openExceptions, setOpenExceptions] = useState(0);

  // Badge the Exceptions link so supervisors see the open count without
  // visiting the page. Refreshes each minute; failures just hide the badge.
  useEffect(() => {
    let cancelled = false;
    async function loadOpenCount() {
      try {
        const res = await fetch('/api/shift-exceptions', { cache: 'no-store' });
        if (!res.ok) return;
        const body = await res.json();
        if (!cancelled) setOpenExceptions(Number(body?.summary?.open) || 0);
      } catch {
        // Leave the last known count in place.
      }
    }
    loadOpenCount();
    const interval = setInterval(loadOpenCount, 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [pathname]);

  function badgeFor(href: string) {
    return href === '/exceptions' && openExceptions > 0 ? openExceptions : null;
  }

  async function handleLogout() {
    setLogoutError('');

    try {
      if (authActions?.signOut) {
        await authActions.signOut();
      }
    } catch {
      setLogoutError('Sign out failed. Please try again.');
      router.refresh();
      return;
    }

    router.push('/login');
    router.refresh();
  }

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden md:flex flex-col w-[260px] bg-navy-900/70 backdrop-blur-xl border-r border-navy-600/40 min-h-screen fixed left-0 top-0 z-30">
        {/* Logo */}
        <div className="px-6 py-5 border-b border-navy-600/40">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gold/10 border border-gold/20 flex items-center justify-center">
              <svg className="w-5 h-5 text-gold" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
              </svg>
            </div>
            <div>
              <h1 className="text-base font-display font-bold text-slate-100 tracking-tight">
                <span className="text-gold">FW</span> Gatekeeper
              </h1>
              <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">Command Center</p>
            </div>
          </div>
        </div>

        {/* Navigation, grouped by the shift-trust loop */}
        <nav className="flex-1 px-3 py-4 space-y-4 overflow-y-auto">
          {navGroups.map((group) => {
            const groupLinks = visibleLinks.filter((l) => l.group === group);
            if (groupLinks.length === 0) return null;
            return (
              <div key={group} className="space-y-0.5">
                <p className="section-label px-3 mb-2">{group}</p>
                {groupLinks.map((l) => {
                  const isActive = pathname === l.href;
                  const badge = badgeFor(l.href);
                  return (
                    <Link
                      key={l.href}
                      href={l.href}
                      aria-current={isActive ? 'page' : undefined}
                      className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 group ${
                        isActive
                          ? 'bg-gold/10 text-gold border border-gold/15 shadow-sm shadow-gold/5'
                          : 'text-slate-400 hover:text-slate-200 hover:bg-navy-700/50 border border-transparent'
                      }`}
                    >
                      <span className={`transition-colors ${isActive ? 'text-gold' : 'text-slate-500 group-hover:text-slate-300'}`}>
                        {l.icon}
                      </span>
                      {l.label}
                      {badge !== null && (
                        <span className="ml-auto min-w-[1.4rem] rounded-full bg-red-400/15 px-1.5 py-0.5 text-center text-[11px] font-semibold text-red-300">
                          {badge}
                        </span>
                      )}
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </nav>

        {/* Account controls */}
        <div className="p-3 border-t border-navy-600/40">
          <Link href="/change-password" className="block px-3 py-2.5 text-sm text-slate-300 hover:text-gold">Change password</Link>
          {logoutError && (
            <p role="alert" className="px-3 pb-2 text-xs text-red-400">
              {logoutError}
            </p>
          )}
          <button
            onClick={handleLogout}
            className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-slate-500 hover:text-red-400 hover:bg-red-400/5 transition-all duration-200 w-full"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
            </svg>
            Sign Out
          </button>
        </div>
      </aside>

      {/* Mobile header */}
      <header className="md:hidden fixed top-0 left-0 right-0 z-30 bg-navy-950/92 backdrop-blur-xl border-b border-navy-600/40 safe-area-top">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-gold/10 border border-gold/20 flex items-center justify-center shrink-0">
              <svg className="w-5 h-5 text-gold" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
              </svg>
            </div>
            <div className="min-w-0">
              <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">FW Gatekeeper</p>
              <h1 className="text-base font-display font-semibold text-slate-100 truncate">
                {currentLink?.label ?? 'Command Center'}
              </h1>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setMobileMenuOpen((open) => !open)}
            aria-expanded={mobileMenuOpen}
            aria-controls="mobile-more-menu"
            className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold transition-colors ${
              mobileMenuOpen || moreIsActive
                ? 'border-gold/30 bg-gold/10 text-gold'
                : 'border-navy-600/60 bg-navy-800/80 text-slate-300'
            }`}
          >
            Menu
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d={mobileMenuOpen ? 'M6 18L18 6M6 6l12 12' : 'M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5'} />
            </svg>
          </button>
        </div>
      </header>

      {mobileMenuOpen && (
        <div className="md:hidden fixed inset-0 z-40">
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 bg-navy-950/70 backdrop-blur-sm"
            onClick={() => setMobileMenuOpen(false)}
          />
          <div
            id="mobile-more-menu"
            className="absolute left-3 right-3 bottom-24 max-h-[65vh] overflow-y-auto rounded-3xl border border-navy-600/60 bg-navy-900/95 p-3 shadow-2xl shadow-black/40"
          >
            <div className="px-2 pb-2">
              <p className="section-label">More pages</p>
              <p className="text-xs text-slate-500">Secondary tools stay here instead of crowding the bottom bar.</p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {mobileSecondaryLinks.map((l) => {
                const isActive = pathname === l.href;
                return (
                  <Link
                    key={l.href}
                    href={l.href}
                    onClick={() => setMobileMenuOpen(false)}
                    aria-current={isActive ? 'page' : undefined}
                    className={`flex items-center gap-3 rounded-2xl border px-3 py-3 text-sm font-medium transition-colors ${
                      isActive
                        ? 'border-gold/25 bg-gold/10 text-gold'
                        : 'border-navy-600/40 bg-navy-800/50 text-slate-300 hover:border-slate-600'
                    }`}
                  >
                    <span className={isActive ? 'text-gold' : 'text-slate-500'}>{l.icon}</span>
                    <span className="leading-tight">{l.label}</span>
                  </Link>
                );
              })}
            </div>
            <div className="mt-3 border-t border-navy-600/40 pt-3">
              <Link href="/change-password" onClick={() => setMobileMenuOpen(false)} className="block px-3 py-2.5 text-sm text-slate-300 hover:text-gold">Change password</Link>
              {logoutError && (
                <p role="alert" className="px-2 pb-2 text-xs text-red-400">
                  {logoutError}
                </p>
              )}
              <button
                onClick={handleLogout}
                className="flex w-full items-center justify-center gap-2 rounded-2xl border border-red-400/10 bg-red-400/5 px-4 py-3 text-sm font-semibold text-red-300 transition-colors hover:bg-red-400/10"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
                </svg>
                Sign Out
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mobile primary tabs */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-navy-900/95 backdrop-blur-xl border-t border-navy-600/40 grid grid-cols-4 z-30 safe-area-bottom">
        {mobilePrimaryLinks.map((l) => {
          const isActive = pathname === l.href;
          return (
            <Link
              key={l.href}
              href={l.href}
              aria-current={isActive ? 'page' : undefined}
              className={`flex flex-col items-center gap-1 px-1 py-2.5 text-[11px] font-medium transition-colors ${
                isActive ? 'text-gold' : 'text-slate-500'
              }`}
            >
              <span className="relative">
                <span className={isActive ? 'text-gold' : 'text-slate-500'}>{l.icon}</span>
                {badgeFor(l.href) !== null && (
                  <span className="absolute -right-2.5 -top-1.5 min-w-[1.1rem] rounded-full bg-red-400/90 px-1 text-center text-[10px] font-bold leading-4 text-navy-950">
                    {badgeFor(l.href)}
                  </span>
                )}
              </span>
              <span className="max-w-full truncate">{l.label.replace(' Face', '')}</span>
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMobileMenuOpen((open) => !open)}
          className={`flex flex-col items-center gap-1 px-1 py-2.5 text-[11px] font-medium transition-colors ${
            mobileMenuOpen || moreIsActive ? 'text-gold' : 'text-slate-500'
          }`}
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 12a.75.75 0 11-1.5 0 .75.75 0 011.5 0zM12.75 12a.75.75 0 11-1.5 0 .75.75 0 011.5 0zM18.75 12a.75.75 0 11-1.5 0 .75.75 0 011.5 0z" />
          </svg>
          More
        </button>
      </nav>
    </>
  );
}
