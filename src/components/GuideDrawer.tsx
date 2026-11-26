'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { canRoleUseGuide, getGuideForPath, getGuideSteps } from '@/lib/app-guides';
import { usePortalRole } from '@/hooks/usePortalRole';

export default function GuideDrawer() {
  const pathname = usePathname();
  const guide = getGuideForPath(pathname);
  const currentRole = usePortalRole();
  const [open, setOpen] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const previousPathnameRef = useRef(pathname);
  const wasOpenRef = useRef(false);

  const relatedLinks = (guide?.related || []).filter((link) => {
    const linkedGuide = getGuideForPath(link.href);
    return !linkedGuide || canRoleUseGuide(linkedGuide, currentRole);
  });

  const closeGuide = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (previousPathnameRef.current !== pathname) {
      previousPathnameRef.current = pathname;
      setOpen(false);
    }
  }, [pathname]);

  useEffect(() => {
    if (!open) {
      if (wasOpenRef.current) {
        wasOpenRef.current = false;
        triggerRef.current?.focus();
      }
      return;
    }
    wasOpenRef.current = true;
    const pageStyle = document.documentElement.style;
    const previousOverflowY = pageStyle.overflowY;
    pageStyle.overflowY = 'hidden';
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeGuide();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      pageStyle.overflowY = previousOverflowY;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, closeGuide]);

  if (pathname === '/guide') return null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="fixed bottom-[calc(5.75rem+env(safe-area-inset-bottom))] right-4 z-20 inline-flex items-center gap-2 rounded-full border border-gold/25 bg-navy-800/95 px-4 py-2.5 text-sm font-semibold text-gold shadow-xl shadow-black/30 backdrop-blur-xl transition-colors hover:border-gold/50 hover:bg-navy-700 md:bottom-6 md:right-6"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 9a3.375 3.375 0 116.75 0c0 2.25-3.375 2.25-3.375 4.5M12 17.25h.008v.008H12v-.008z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span className="md:hidden">Help</span>
        <span className="hidden md:inline">How to use this page</span>
      </button>

      {open && (
        <div className="fixed inset-0 z-50">
          <button type="button" tabIndex={-1} aria-label="Close page guide" onClick={() => closeGuide()} className="absolute inset-0 bg-navy-950/75 backdrop-blur-sm" />
          <aside
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="page-guide-title"
            className="absolute inset-y-0 right-0 flex w-full max-w-md flex-col border-l border-navy-600/60 bg-navy-900 shadow-2xl shadow-black/50 animate-slide-up"
          >
            <div className="flex items-start justify-between gap-4 border-b border-navy-600/50 px-5 py-5">
              <div>
                <p className="section-label text-gold">{guide?.eyebrow ?? 'Application guide'}</p>
                <h2 id="page-guide-title" className="mt-2 font-display text-2xl font-semibold text-slate-100">
                  {guide ? `How to use ${guide.title}` : 'Need help with this page?'}
                </h2>
              </div>
              <button ref={closeButtonRef} type="button" onClick={() => closeGuide()} className="btn-ghost -mr-2 -mt-2" aria-label="Close guide">
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-6">
              {guide ? (
                <div className="space-y-7">
                  {currentRole === undefined ? (
                    <div role="status" className="rounded-xl border border-cyan-400/15 bg-cyan-400/5 px-4 py-3 text-sm leading-6 text-cyan-100">
                      Loading guidance for your account. We’ll show only actions available to your role.
                    </div>
                  ) : !canRoleUseGuide(guide, currentRole) ? (
                    <div className="rounded-xl border border-amber-400/20 bg-amber-400/5 px-4 py-3 text-sm leading-6 text-amber-100">
                      This page does not have guidance for your role. Open the Guide Center to see the workflows available to your account.
                    </div>
                  ) : (
                    <>
                      <p className="text-sm leading-6 text-slate-300">{guide.purpose}</p>
                      {guide.roleNotes?.[currentRole] && (
                        <div className="rounded-xl border border-gold/20 bg-gold/5 px-4 py-3 text-sm leading-6 text-amber-100">
                          <span className="font-semibold text-gold">For your role: </span>{guide.roleNotes[currentRole]}
                        </div>
                      )}
                      <section>
                        <h3 className="section-label mb-3">Recommended steps</h3>
                        <ol className="space-y-3">
                          {getGuideSteps(guide, currentRole).map((step, index) => (
                            <li key={step} className="flex gap-3 text-sm leading-6 text-slate-300">
                              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-gold/25 bg-gold/10 font-mono text-xs font-semibold text-gold">{index + 1}</span>
                              <span>{step}</span>
                            </li>
                          ))}
                        </ol>
                      </section>
                      <section className="rounded-xl border border-cyan-400/15 bg-cyan-400/5 p-4">
                        <h3 className="section-label text-cyan-300">Good to know</h3>
                        <ul className="mt-3 space-y-2 text-sm leading-6 text-slate-400">
                          {guide.tips.map((tip) => <li key={tip}>• {tip}</li>)}
                        </ul>
                      </section>
                      {relatedLinks.length > 0 && (
                        <section>
                          <h3 className="section-label mb-3">Related pages</h3>
                          <div className="flex flex-wrap gap-2">
                            {relatedLinks.map((link) => <Link key={link.href} href={link.href} className="btn-secondary text-xs">{link.label}</Link>)}
                          </div>
                        </section>
                      )}
                    </>
                  )}
                </div>
              ) : (
                <p className="text-sm leading-6 text-slate-400">This page does not have a dedicated walkthrough yet. Open the Guide Center for the main workflows and page directory.</p>
              )}
            </div>

            <div className="border-t border-navy-600/50 p-5">
              <Link href="/guide" className="btn-primary block w-full text-center">Open Guide Center</Link>
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
