'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '@/components/Toast';

type KioskReadinessStatus = 'online' | 'stale' | 'offline' | 'never_synced';

type KioskHealthRow = {
  id: string;
  name: string;
  kiosk_id: string | null;
  type: string;
  location: string;
  last_sync: string | null;
  roster_applied_at: string | null;
  purge_pending: boolean;
  status: KioskReadinessStatus;
  expected_worker_count: number;
  last_attendance_upload: string | null;
  device_issues?: string[];
};

type SystemHealthPayload = {
  checked_at: string;
  kiosks: {
    total: number;
    counts: Record<KioskReadinessStatus, number>;
    stale_threshold_minutes: number;
    offline_threshold_minutes: number;
    rows: KioskHealthRow[];
  };
  sync: {
    ready_worker_count: number;
    last_attendance_upload: string | null;
  };
  warnings: string[];
};

const statusStyles: Record<KioskReadinessStatus, string> = {
  online: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/20',
  stale: 'bg-amber-400/10 text-amber-300 border-amber-400/20',
  offline: 'bg-red-400/10 text-red-300 border-red-400/20',
  never_synced: 'bg-slate-400/10 text-slate-300 border-slate-400/20',
};

const statusLabels: Record<KioskReadinessStatus, string> = {
  online: 'Online',
  stale: 'Stale',
  offline: 'Offline',
  never_synced: 'Never synced',
};

function formatTimestamp(value: string | null) {
  if (!value) return 'No data yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Invalid timestamp';
  return date.toLocaleString();
}

export default function KiosksPage() {
  const { toast } = useToast();
  const [health, setHealth] = useState<SystemHealthPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [kioskId, setKioskId] = useState('');
  const [type, setType] = useState<'entry' | 'exit'>('entry');
  const [location, setLocation] = useState('');
  const [issuedCredential, setIssuedCredential] = useState<{ kioskId: string; value: string } | null>(null);
  const [credentialBusy, setCredentialBusy] = useState<string | null>(null);
  const credentialBusyRef = useRef(false);
  const [credentialStatus, setCredentialStatus] = useState<Record<string, 'device' | 'legacy' | 'revoked'>>({});

  const fetchCredentialStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/kiosks', { cache: 'no-store' });
      if (!response.ok) return;
      const rows = await response.json();
      if (Array.isArray(rows)) setCredentialStatus(Object.fromEntries(rows.map(row => [row.id, row.credential_status])));
    } catch {
      // Readiness remains available if the credential status request fails.
    }
  }, []);

  const manageCredential = async (id: string, method: 'POST' | 'DELETE', kioskName?: string) => {
    if (credentialBusyRef.current || issuedCredential) return;
    if (method === 'DELETE' && !globalThis.confirm(`Revoke access for ${kioskName || id}? This kiosk will stop syncing immediately, including if it still uses the shared migration key. To restore sync, issue a new device credential and install it on the Pi.`)) return;
    credentialBusyRef.current = true;
    setCredentialBusy(id);
    try {
      const response = await fetch('/api/kiosks/credentials', {
        method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, ...(method === 'DELETE' ? { confirmStopSync: true } : {}) }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Credential change failed');
      if (method === 'POST') setIssuedCredential({ kioskId: body.kiosk_id, value: body.credential });
      else toast('Kiosk credential revoked');
      fetchCredentialStatus();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Credential change failed', 'error');
    } finally {
      credentialBusyRef.current = false;
      setCredentialBusy(null);
    }
  };

  const fetchReadiness = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/system-health', { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || 'Failed to load kiosk readiness');
      setHealth(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load kiosk readiness';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchReadiness();
    fetchCredentialStatus();
  }, [fetchReadiness, fetchCredentialStatus]);

  const counts = health?.kiosks.counts;
  const deviceIssueCount = useMemo(
    () => (health?.kiosks.rows || []).reduce((total, row) => total + (row.device_issues?.length || 0), 0),
    [health],
  );
  const readinessLabel = useMemo(() => {
    if (!health) return 'Checking readiness';
    if (health.kiosks.total === 0) return 'No kiosks registered';
    if ((counts?.offline || 0) + (counts?.never_synced || 0) > 0) return 'Kiosks need attention';
    // A kiosk can be syncing (online) while its camera or model is broken.
    if (deviceIssueCount > 0) return 'Kiosks report device issues';
    if ((counts?.stale || 0) > 0) return 'Some kiosks are stale';
    return 'All kiosks online';
  }, [counts, deviceIssueCount, health]);

  const handleSubmit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast('Kiosk name required', 'error');
      return;
    }

    try {
      const res = await fetch('/api/kiosks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: trimmedName,
          kiosk_id: kioskId.trim() || undefined,
          type,
          location: location.trim(),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || 'Failed to register kiosk');
      toast(`Kiosk "${trimmedName}" registered`);
      setName('');
      setKioskId('');
      setLocation('');
      setType('entry');
      setShowForm(false);
      fetchReadiness();
      fetchCredentialStatus();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to register kiosk', 'error');
    }
  };

  return (
    <div className="animate-fade-in space-y-6 pb-24 md:pb-8">
      {issuedCredential && (
        <div role="alert" className="glass-card p-5 border border-amber-400/30 space-y-2">
          <p className="text-amber-200 font-semibold">Save this credential for {issuedCredential.kioskId}. It will only be shown once.</p>
          <code className="block break-all select-all text-sm text-slate-100">{issuedCredential.value}</code>
          <p className="text-xs text-slate-400">Set it as KIOSK_API_KEY on this Pi. The old shared key no longer works for this kiosk.</p>
          <button type="button" className="btn-secondary" onClick={() => setIssuedCredential(null)}>Dismiss</button>
        </div>
      )}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <p className="section-label mb-2">Device Operations</p>
          <h1 className="page-title text-slate-100">
            Kiosk <span className="text-gold">readiness</span>
          </h1>
          <p className="text-sm text-slate-400 mt-2 max-w-2xl leading-6">
            Check each kiosk&apos;s last contact, acknowledged roster, biometric purge status,
            and attendance uploads.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={fetchReadiness} className="btn-secondary" disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button onClick={() => setShowForm(!showForm)} className={showForm ? 'btn-secondary' : 'btn-primary'}>
            {showForm ? 'Cancel' : 'Add Kiosk'}
          </button>
        </div>
      </div>

      <section className="glass-card p-5">
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <p className="section-label mb-2">Kiosk readiness</p>
            <h2 className="font-display text-2xl text-slate-100">{readinessLabel}</h2>
            <p className="text-sm text-slate-400 mt-2">
              Online means contacted within {health?.kiosks.stale_threshold_minutes ?? 15} minutes; stale means 15–{health?.kiosks.offline_threshold_minutes ?? 60} minutes; offline means over {health?.kiosks.offline_threshold_minutes ?? 60} minutes. Contact does not confirm roster changes were applied.
            </p>
          </div>
          <span className="badge bg-gold/10 text-gold border border-gold/20">
            {health?.sync.ready_worker_count ?? 0} Expected worker records
          </span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-5">
          {(['online', 'stale', 'offline', 'never_synced'] as KioskReadinessStatus[]).map((status) => (
            <div key={status} className="rounded-xl border border-navy-600/50 bg-navy-900/35 p-4">
              <p className="text-xs text-slate-500">{statusLabels[status]}</p>
              <p className="font-display text-2xl text-slate-100 mt-1">{counts?.[status] ?? 0}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-amber-400/20 bg-amber-400/5 p-5">
        <h2 className="font-display font-semibold text-amber-200">Kiosk setup reminder</h2>
        <p className="text-sm text-amber-100/80 leading-6 mt-2">
          Each Raspberry Pi kiosk must point at this portal URL. For a kiosk with an issued device credential, set that credential as <code className="font-mono">KIOSK_API_KEY</code> on its Pi; it is shown only once and does not match the shared key in Render. A kiosk still marked Shared key migration uses the shared Render key until you issue its device credential.
        </p>
      </section>

      {showForm && (
        <section className="glass-card p-6 space-y-4 animate-slide-up">
          <h2 className="font-display font-semibold text-gold">Register New Kiosk</h2>
          <div>
            <label className="section-label mb-1.5 block">Kiosk Name</label>
            <input placeholder="e.g. Main Entrance Kiosk" value={name} onChange={(e) => setName(e.target.value)} className="input-field" />
          </div>
          <div>
            <label className="section-label mb-1.5 block">Kiosk ID</label>
            <input
              placeholder={type === 'entry' ? 'kiosk-entry-1' : 'kiosk-exit-1'}
              value={kioskId}
              onChange={(e) => setKioskId(e.target.value)}
              className="input-field"
            />
          </div>
          <div>
            <label className="section-label mb-1.5 block">Type</label>
            <div className="flex gap-3">
              <button onClick={() => setType('entry')} className={`flex-1 py-3 rounded-xl text-sm font-medium border transition-all ${type === 'entry' ? 'bg-emerald-400/10 text-emerald-400 border-emerald-400/20' : 'bg-navy-900/50 text-slate-400 border-navy-600/50 hover:border-slate-600'}`}>Entry</button>
              <button onClick={() => setType('exit')} className={`flex-1 py-3 rounded-xl text-sm font-medium border transition-all ${type === 'exit' ? 'bg-amber-400/10 text-amber-400 border-amber-400/20' : 'bg-navy-900/50 text-slate-400 border-navy-600/50 hover:border-slate-600'}`}>Exit</button>
            </div>
          </div>
          <div>
            <label className="section-label mb-1.5 block">Location</label>
            <input placeholder="e.g. Building A, Front Gate" value={location} onChange={(e) => setLocation(e.target.value)} className="input-field" />
          </div>
          <button onClick={handleSubmit} className="btn-primary">Register Kiosk</button>
        </section>
      )}

      {error && (
        <div role="alert" className="rounded-xl border border-red-400/20 bg-red-400/5 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {loading && !health ? (
        <div className="glass-card p-6 text-sm text-slate-400">Loading kiosk readiness…</div>
      ) : (
        <section className="space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <h2 className="font-display font-semibold text-slate-100">Registered kiosks</h2>
            <span className="text-xs font-mono text-slate-500">{health?.kiosks.total ?? 0} devices</span>
          </div>
          {health?.kiosks.rows.length ? (
            <div className="grid gap-4 lg:grid-cols-2">
              {health.kiosks.rows.map((kiosk) => (
                <article key={kiosk.id} className="glass-card-hover p-5 space-y-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="font-display font-medium text-slate-100">{kiosk.name}</h3>
                      <p className="text-xs font-mono text-slate-500 mt-1">{kiosk.kiosk_id || kiosk.id}</p>
                    </div>
                    <span className={`badge border ${statusStyles[kiosk.status]}`}>{statusLabels[kiosk.status]}</span>
                  </div>
                  <div className="flex gap-2">
                    <span className="badge border border-slate-500/30 text-slate-300">{credentialStatus[kiosk.id] === 'device' ? 'Device credential active' : credentialStatus[kiosk.id] === 'revoked' ? 'Credential revoked' : credentialStatus[kiosk.id] === 'legacy' ? 'Shared key migration' : 'Checking credential'}</span>
                    <button type="button" className="btn-secondary text-xs" disabled={credentialBusy !== null || issuedCredential !== null}
                      onClick={() => manageCredential(kiosk.id, 'POST')}>Issue / rotate credential</button>
                    <button type="button" className="btn-secondary text-xs" disabled={credentialBusy !== null || issuedCredential !== null}
                      onClick={() => manageCredential(kiosk.id, 'DELETE', kiosk.name)}>Revoke access</button>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2 text-sm">
                    <div className="rounded-xl bg-navy-900/40 border border-navy-600/40 p-3">
                      <p className="text-xs text-slate-500">Location</p>
                      <p className="text-slate-200 mt-1">{kiosk.location || 'No location set'}</p>
                    </div>
                    <div className="rounded-xl bg-navy-900/40 border border-navy-600/40 p-3">
                      <p className="text-xs text-slate-500">Last contact</p>
                      <p className="text-slate-200 mt-1">{formatTimestamp(kiosk.last_sync)}</p>
                    </div>
                    <div className="rounded-xl bg-navy-900/40 border border-navy-600/40 p-3">
                      <p className="text-xs text-slate-500">Last applied roster</p>
                      <p className="text-slate-200 mt-1">{kiosk.roster_applied_at ? formatTimestamp(kiosk.roster_applied_at) : 'Unconfirmed (legacy or pending acknowledgement)'}</p>
                    </div>
                    <div className="rounded-xl bg-navy-900/40 border border-navy-600/40 p-3">
                      <p className="text-xs text-slate-500">Biometric purge</p>
                      <p className={kiosk.purge_pending ? 'text-amber-300 mt-1' : 'text-slate-200 mt-1'}>
                        {kiosk.purge_pending ? 'Pending confirmation on this kiosk' : kiosk.roster_applied_at ? 'No pending purge' : 'Not confirmed by this kiosk'}
                      </p>
                    </div>
                    <div className="rounded-xl bg-navy-900/40 border border-navy-600/40 p-3">
                      <p className="text-xs text-slate-500">Expected worker payload</p>
                      <p className="text-slate-200 mt-1">{kiosk.expected_worker_count} workers</p>
                    </div>
                    <div className="rounded-xl bg-navy-900/40 border border-navy-600/40 p-3">
                      <p className="text-xs text-slate-500">Last attendance upload</p>
                      <p className="text-slate-200 mt-1">{formatTimestamp(kiosk.last_attendance_upload)}</p>
                    </div>
                  </div>
                  {(kiosk.device_issues?.length || 0) > 0 && (
                    <div className="rounded-xl border border-amber-400/20 bg-amber-400/5 p-3">
                      <p className="text-xs text-amber-200 font-semibold">Device issues reported by the kiosk</p>
                      <ul className="mt-1 space-y-1">
                        {kiosk.device_issues!.map((issue) => (
                          <li key={issue} className="text-xs text-amber-300">{issue}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <div className="glass-card p-6 text-sm text-slate-400 leading-6">
              No kiosks are registered yet. Add a kiosk record, then configure the Pi with the portal URL and an issued device credential as <code className="font-mono">KIOSK_API_KEY</code> before launch.
            </div>
          )}
        </section>
      )}
    </div>
  );
}
