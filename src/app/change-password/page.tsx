'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthActions } from '@convex-dev/auth/react';
import { useAction } from 'convex/react';
import { ConvexError } from 'convex/values';
import { api } from '../../../convex/_generated/api';

export default function ChangePasswordPage() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const changePassword = useAction(api.portalMembers.changePassword);
  const { signOut } = useAuthActions();
  const router = useRouter();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    if (newPassword !== confirmation) {
      setError('New passwords do not match.');
      return;
    }
    setLoading(true);
    try {
      await changePassword({ currentPassword, newPassword });
    } catch (caught) {
      const code = caught instanceof ConvexError ? caught.data : null;
      setError(code === 'INVALID_CURRENT_PASSWORD' ? 'Current password is incorrect.'
        : code === 'TOO_MANY_ATTEMPTS' ? 'Too many attempts. Try again later.'
        : code === 'PASSWORD_CHANGE_CONFLICT' ? 'Your account changed while the password was being updated. Try again.'
        : caught instanceof Error ? caught.message : 'Unable to change password.');
      setLoading(false);
      return;
    }
    // The backend already revoked all sessions. Clear browser auth too, even
    // if sign-out fails after that revocation, then sign in with the new secret.
    await signOut().catch(() => {});
    router.replace('/login');
    router.refresh();
  }

  async function exit() {
    await signOut();
    router.replace('/login');
    router.refresh();
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-navy-950 relative overflow-hidden">
      <div className="absolute inset-0 bg-grid-pattern bg-grid opacity-30" />
      <div className="w-full max-w-md p-8 relative z-10 animate-fade-in">
        <h1 className="text-3xl font-display font-bold text-slate-100 mb-3">Change your password</h1>
        <p className="text-sm text-slate-300 mb-6">Choose a password only you know to continue. You will sign in again after changing it.</p>
        <div className="glass-card p-6">
          <form onSubmit={submit} className="space-y-5">
            {[
              { id: 'current-password', label: 'Current password', value: currentPassword, set: setCurrentPassword, autoComplete: 'current-password' },
              { id: 'new-password', label: 'New password', value: newPassword, set: setNewPassword, autoComplete: 'new-password' },
              { id: 'confirm-password', label: 'Confirm new password', value: confirmation, set: setConfirmation, autoComplete: 'new-password' },
            ].map(field => (
              <div key={field.id}>
                <label htmlFor={field.id} className="section-label mb-2 block">{field.label}</label>
                <input id={field.id} type="password" autoComplete={field.autoComplete} required
                  value={field.value} onChange={event => field.set(event.target.value)}
                  className="w-full px-4 py-3 bg-navy-900/80 border border-navy-600/50 rounded-xl text-slate-100 focus:outline-none focus:border-gold/40 focus:ring-1 focus:ring-gold/20" />
              </div>
            ))}
            <p className="text-xs text-slate-300">Use at least 8 characters, uppercase and lowercase letters, and a number or symbol. Choose a different password from your current one.</p>
            {error && <div role="alert" className="text-red-400 text-sm border border-red-400/20 rounded-xl px-4 py-2.5">{error}</div>}
            <button type="submit" disabled={loading} className="btn-primary w-full py-3.5">
              {loading ? 'Changing password…' : 'Change password'}
            </button>
            <button type="button" disabled={loading} onClick={exit} className="w-full text-sm text-slate-300 hover:text-gold">Sign out</button>
          </form>
        </div>
      </div>
    </div>
  );
}
