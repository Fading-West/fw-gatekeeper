'use client';

import { useMemo, useState } from 'react';
import { useAction, useMutation, useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { useToast } from '@/components/Toast';

type PortalRole = 'admin' | 'enrollment' | 'viewer';

type CreatedAccount = {
  email: string;
  password: string;
  role: PortalRole;
};

function getPasswordPolicyError(password: string) {
  if (password.length < 8) {
    return 'Initial password must be at least 8 characters';
  }
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>/?`~]/.test(password)) {
    return 'Initial password must include uppercase, lowercase, and a number or symbol';
  }
  return null;
}

function getActionErrorMessage(error: unknown) {
  if (error && typeof error === 'object' && 'data' in error && typeof error.data === 'string') {
    return error.data;
  }
  return error instanceof Error ? error.message : 'Failed to update account';
}

const roleDescriptions: Record<PortalRole, string> = {
  admin: 'Full portal access, including creating user accounts.',
  enrollment: 'Can use the portal for face enrollment and day-to-day review pages.',
  viewer: 'Read-oriented portal access for review and reporting.',
};

function generatePassword() {
  const groups = [
    'ABCDEFGHJKLMNPQRSTUVWXYZ',
    'abcdefghijkmnopqrstuvwxyz',
    '23456789',
    '!@#$%*-_+=',
  ];
  const alphabet = groups.join('');
  const pick = (chars: string) => {
    const value = new Uint32Array(1);
    crypto.getRandomValues(value);
    return chars[value[0] % chars.length];
  };
  const required = groups.map(pick);
  const values = new Uint32Array(16);
  crypto.getRandomValues(values);
  const rest = Array.from(values, (value) => alphabet[value % alphabet.length]);
  return [...required, ...rest]
    .sort(() => {
      const value = new Uint32Array(1);
      crypto.getRandomValues(value);
      return value[0] % 3 - 1;
    })
    .join('');
}

export default function AccountsPage() {
  const { toast } = useToast();
  const currentMember = useQuery(api.portalMembers.current, {});
  const isAdmin = currentMember?.role === 'admin';
  const members = useQuery(api.portalMembers.list, isAdmin ? {} : 'skip');
  const createPortalAccount = useAction(api.portalMembers.createPortalAccount);
  const resetPortalAccountPassword = useAction(api.portalMembers.resetPortalAccountPassword);
  const updateRole = useMutation(api.portalMembers.setRole);
  const setActive = useMutation(api.portalMembers.setActive);

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<PortalRole>('enrollment');
  const [password, setPassword] = useState(() => generatePassword());
  const [submitting, setSubmitting] = useState(false);
  const [createdAccount, setCreatedAccount] = useState<CreatedAccount | null>(null);
  const [updatingUserId, setUpdatingUserId] = useState<string | null>(null);

  const sortedMembers = useMemo(() => [...(members ?? [])], [members]);
  const normalizedEmail = email.trim().toLowerCase();
  const existingMember = useMemo(
    () => sortedMembers.find((member) => member.email.toLowerCase() === normalizedEmail),
    [normalizedEmail, sortedMembers]
  );

  async function handleCreateAccount() {
    if (!normalizedEmail) {
      toast('Email is required', 'error');
      return;
    }
    const passwordError = getPasswordPolicyError(password);
    if (passwordError) {
      toast(passwordError, 'error');
      return;
    }
    if (existingMember) {
      const confirmed = window.confirm(
        `Reset the password for ${normalizedEmail}? This will sign out any existing sessions for that user.`
      );
      if (!confirmed) {
        return;
      }
    }

    setSubmitting(true);
    setCreatedAccount(null);
    try {
      const result = existingMember
        ? await resetPortalAccountPassword({ email: normalizedEmail, password, role: existingMember.role })
        : await createPortalAccount({ email: normalizedEmail, password, role });
      setCreatedAccount({ email: result.email, password, role: result.role });
      setEmail('');
      setPassword(generatePassword());
      setRole('enrollment');
      toast(existingMember ? `Password updated for ${result.email}` : `Account ready for ${result.email}`);
    } catch (error) {
      const message = getActionErrorMessage(error);
      toast(message, 'error');
    } finally {
      setSubmitting(false);
    }
  }

  async function copyCredentials() {
    if (!createdAccount) return;
    const text = `FW Gatekeeper login\nhttps://fw-gatekeeper.onrender.com/login\n\nEmail: ${createdAccount.email}\nInitial password: ${createdAccount.password}`;
    await navigator.clipboard.writeText(text);
    toast('Credentials copied');
  }

  async function updateMember(userId: typeof sortedMembers[number]['userId'], change: { role: PortalRole } | { active: boolean }) {
    setUpdatingUserId(userId);
    try {
      if ('role' in change) await updateRole({ userId, role: change.role });
      else await setActive({ userId, active: change.active });
      toast('Account updated');
    } catch (error) {
      toast(getActionErrorMessage(error), 'error');
    } finally {
      setUpdatingUserId(null);
    }
  }

  if (currentMember === undefined || (isAdmin && members === undefined)) {
    return (
      <div className="animate-fade-in">
        <h1 className="page-title text-slate-100">Account <span className="text-gold">Management</span></h1>
        <div className="glass-card p-6 text-sm text-slate-400">Loading account access…</div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="animate-fade-in max-w-3xl">
        <h1 className="page-title text-slate-100">Account <span className="text-gold">Management</span></h1>
        <div className="glass-card p-6 border-l-4 border-red-400/70">
          <h2 className="font-display font-semibold text-red-300 mb-2">Admin access required</h2>
          <p className="text-sm text-slate-400 leading-6">
            Only admin portal accounts can create or review user accounts.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <div className="flex items-start justify-between mb-8 flex-wrap gap-4">
        <div>
          <h1 className="page-title text-slate-100">
            Account <span className="text-gold">Management</span>
          </h1>
          <p className="text-sm text-slate-500 mt-1 font-mono">
            Create and manage named portal logins for Fading West users
          </p>
        </div>
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)] gap-6 mb-8">
        <div className="glass-card p-6">
          <h2 className="font-display font-semibold text-gold mb-4">Add user account</h2>
          <div className="space-y-4">
            <div>
              <label className="section-label mb-1.5 block">Email</label>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@fadingwest.com"
                className="input-field"
                autoComplete="off"
              />
            </div>

            <div>
              <label className="section-label mb-1.5 block">Role</label>
              <select
                value={existingMember?.role ?? role}
                onChange={(event) => setRole(event.target.value as PortalRole)}
                disabled={Boolean(existingMember)}
                className="input-field"
              >
                <option value="enrollment">Enrollment</option>
                <option value="viewer">Viewer</option>
                <option value="admin">Admin</option>
              </select>
              <p className="text-xs text-slate-500 mt-2 leading-5">{roleDescriptions[existingMember?.role ?? role]}</p>
            </div>

            <div>
              <label className="section-label mb-1.5 block">Initial password</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="input-field font-mono"
                  autoComplete="new-password"
                />
                <button type="button" onClick={() => setPassword(generatePassword())} className="btn-secondary shrink-0">
                  Generate
                </button>
              </div>
              <p className="text-xs text-slate-500 mt-2 leading-5">
                Share this directly with the user. Public self-signup remains disabled.
              </p>
            </div>

            {existingMember && (
              <div className="rounded-xl border border-amber-400/20 bg-amber-400/5 px-4 py-3 text-sm text-amber-200 leading-6">
                This email already has an account. Submitting will reset the password. Use the role control below to change access. A disabled account will remain disabled.
              </div>
            )}

            <button
              type="button"
              onClick={handleCreateAccount}
              disabled={submitting}
              className="btn-primary disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {submitting ? (existingMember ? 'Resetting…' : 'Creating…') : existingMember ? 'Reset Password' : 'Create Account'}
            </button>
          </div>
        </div>

        <div className="glass-card p-6 border-l-4 border-gold/70">
          <h2 className="font-display font-semibold text-gold mb-3">Sharing checklist</h2>
          <ul className="text-sm text-slate-400 space-y-2 leading-6">
            <li>• Use named accounts instead of the shared PIN for humans.</li>
            <li>• Keep kiosk/device access separate through the kiosk API key.</li>
            <li>• Give admin only to people who should create accounts or change portal data.</li>
          </ul>
        </div>
      </div>

      {createdAccount && (
        <div className="glass-card p-5 mb-8 border-l-4 border-emerald-400/70 animate-slide-up">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h2 className="font-display font-semibold text-emerald-300 mb-2">Account ready</h2>
              <div className="text-sm text-slate-300 space-y-1 font-mono">
                <p>Email: {createdAccount.email}</p>
                <p>Initial password: {createdAccount.password}</p>
                <p>Role: {createdAccount.role}</p>
              </div>
            </div>
            <button type="button" onClick={copyCredentials} className="btn-secondary">
              Copy Credentials
            </button>
          </div>
        </div>
      )}

      <div className="glass-card p-6">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <h2 className="font-display font-semibold text-slate-100">Portal users</h2>
          <span className="text-xs font-mono text-slate-500">{sortedMembers.length} accounts</span>
        </div>
        <div className="space-y-2">
          {sortedMembers.map((member) => (
            <div key={member.id} className="rounded-xl border border-navy-600/40 bg-navy-800/30 p-4 flex items-center gap-4">
              <div className="w-10 h-10 rounded-xl bg-gold/10 border border-gold/15 flex items-center justify-center text-sm font-display font-bold text-gold shrink-0">
                {member.email.slice(0, 2).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-display font-medium text-sm text-slate-200 truncate">{member.email}</div>
                <label className="text-xs text-slate-400 flex items-center gap-2 mt-1">
                  Role
                  <select
                    aria-label={`Role for ${member.email}`}
                    value={member.role}
                    disabled={updatingUserId !== null}
                    onChange={(event) => void updateMember(member.userId, { role: event.target.value as PortalRole })}
                    className="rounded border border-navy-600 bg-navy-900 px-2 py-1 text-slate-100"
                  >
                    <option value="admin">Admin</option>
                    <option value="enrollment">Enrollment</option>
                    <option value="viewer">Viewer</option>
                  </select>
                </label>
              </div>
              <span className={`text-xs font-mono px-2.5 py-1 rounded-full border ${member.active ? 'text-emerald-300 border-emerald-400/20 bg-emerald-400/5' : 'text-slate-500 border-slate-500/20 bg-slate-500/5'}`}>
                {member.active ? 'Active' : 'Inactive'}
              </span>
              <button
                type="button"
                disabled={updatingUserId !== null}
                onClick={() => {
                  if (member.active && !window.confirm(`Disable ${member.email}? All active sessions will be revoked.`)) return;
                  void updateMember(member.userId, { active: !member.active });
                }}
                className="btn-secondary text-xs disabled:opacity-60"
              >
                {member.active ? 'Disable' : 'Reactivate'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
