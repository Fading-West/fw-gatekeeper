'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthActions } from '@convex-dev/auth/react';
import { normalizeConvexAuthError } from '@/lib/convex-auth-errors';

export default function LoginPage() {
  return <AuthenticatedLogin />;
}

function AuthenticatedLogin() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [convexError, setConvexError] = useState('');
  const [convexLoading, setConvexLoading] = useState(false);
  const router = useRouter();
  const { signIn } = useAuthActions();

  function finishLogin() {
    router.push('/');
    router.refresh();
  }

  async function handleConvexSubmit(e: React.FormEvent) {
    e.preventDefault();
    setConvexError('');
    setConvexLoading(true);

    try {
      await signIn('password', {
        flow: 'signIn',
        email: email.trim().toLowerCase(),
        password,
      });
      finishLogin();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to authenticate';
      setConvexError(normalizeConvexAuthError(message));
    } finally {
      setConvexLoading(false);
    }
  }

  const convexButtonLabel = 'Sign in with email';

  return (
    <div className="min-h-screen flex items-center justify-center bg-navy-950 relative overflow-hidden">
      <div className="absolute inset-0 bg-grid-pattern bg-grid opacity-30" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-gold/[0.03] rounded-full blur-3xl" />
      <div className="absolute top-1/4 right-1/4 w-[300px] h-[300px] bg-cyan-500/[0.02] rounded-full blur-3xl" />

      <div className="w-full max-w-md p-8 relative z-10 animate-fade-in">
        <div className="text-center mb-10">
          <div className="w-16 h-16 rounded-2xl bg-gold/10 border border-gold/20 flex items-center justify-center mx-auto mb-5 shadow-lg shadow-gold/5">
            <svg className="w-8 h-8 text-gold" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
            </svg>
          </div>
          <h1 className="text-3xl font-display font-bold tracking-tight text-slate-100">
            <span className="text-gold">FW</span> Gatekeeper
          </h1>
          <p className="text-slate-500 text-sm font-mono mt-3 uppercase tracking-widest text-[11px]">Access Control System</p>
        </div>

        <div className="glass-card p-6">
          <form onSubmit={handleConvexSubmit} className="space-y-5">
            <div>
              <label className="section-label mb-2 block">Email</label>
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@fadingwest.com"
                className="w-full px-4 py-3 bg-navy-900/80 border border-navy-600/50 rounded-xl text-slate-100 placeholder-slate-600 focus:outline-none focus:border-gold/40 focus:ring-1 focus:ring-gold/20 transition-all"
                autoFocus
              />
            </div>

            <div>
              <label className="section-label mb-2 block">Password</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter password"
                  className="w-full px-4 py-3 pr-20 bg-navy-900/80 border border-navy-600/50 rounded-xl text-slate-100 placeholder-slate-600 focus:outline-none focus:border-gold/40 focus:ring-1 focus:ring-gold/20 transition-all"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((value) => !value)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-mono uppercase tracking-wider text-slate-400 hover:text-gold transition-colors"
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>

            {convexError && (
              <div role="alert" className="flex items-center gap-2 text-red-400 text-sm bg-red-400/5 border border-red-400/10 rounded-xl px-4 py-2.5">
                {convexError}
              </div>
            )}

            <button
              type="submit"
              disabled={convexLoading || !email.trim() || password.trim().length < 8}
              className="btn-primary w-full py-3.5 text-base"
            >
              {convexLoading ? 'Authenticating...' : convexButtonLabel}
            </button>

            <p className="text-xs text-slate-500 leading-relaxed">
              Sign in with your named portal account. Contact an administrator if you need access.
            </p>
          </form>
        </div>

        <p className="text-center text-[10px] font-mono text-slate-600 mt-8 uppercase tracking-wider">
          Fading West Manufacturing
        </p>
      </div>
    </div>
  );
}
