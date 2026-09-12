'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useToast } from '@/components/Toast';
import { Worker } from '@/lib/types';
import { usePortalRole } from '@/hooks/usePortalRole';

function getEncodingStatus(worker: Worker) {
  if (worker.encoding_status) return worker.encoding_status;
  return worker.has_face_encoding ? 'valid' : 'missing';
}

function hasFaceEncoding(worker: Worker) {
  return getEncodingStatus(worker) === 'valid';
}

function getInitials(name: string) {
  return name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase();
}

export default function WorkersPage() {
  const { toast } = useToast();
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [showInactive, setShowInactive] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [department, setDepartment] = useState('');
  const currentRole = usePortalRole();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'valid' | 'missing' | 'invalid'>('all');
  const [departmentFilter, setDepartmentFilter] = useState('all');
  const [sortBy, setSortBy] = useState<'name' | 'employee_id' | 'status'>('name');
  const [viewMode, setViewMode] = useState<'cards' | 'table'>('cards');
  const canEdit = currentRole === 'admin';
  // Re-enrollment is an enrollment-role workflow too: /api/enroll and the
  // worker-by-id prefill both authorize it, and it preserves metadata.
  const canEnroll = currentRole === 'admin' || currentRole === 'enrollment';

  const fetchWorkers = useCallback(async () => {
    if (currentRole === undefined) return;
    setLoading(true);
    setError('');
    try {
      // Non-admin roles are only authorized for the read-scoped roster
      // (readiness metadata, no admin management payload).
      const endpoint = currentRole === 'admin' ? (showInactive ? '/api/workers?active=false' : '/api/workers') : '/api/workers?scope=dashboard';
      const res = await fetch(endpoint);
      if (!res.ok) {
        throw new Error(res.status === 401 ? 'Your account does not have access to the worker list.' : 'Failed to load workers');
      }
      setWorkers(await res.json());
    } catch (err) {
      setWorkers([]);
      setError(err instanceof Error ? err.message : 'Failed to load workers');
    } finally {
      setLoading(false);
    }
  }, [currentRole, showInactive]);

  useEffect(() => { fetchWorkers(); }, [fetchWorkers]);

  const resetEdit = () => {
    setEditId(null);
    setName('');
    setEmployeeId('');
    setDepartment('');
  };

  const handleSubmit = async () => {
    if (!editId) return;
    if (!name.trim()) {
      toast('Name is required', 'error');
      return;
    }

    try {
      const res = await fetch('/api/workers', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: editId, name, employee_id: employeeId, department }),
      });
      if (!res.ok) throw new Error('Failed to update worker');
      toast(`${name} updated successfully`);
      resetEdit();
      fetchWorkers();
    } catch {
      toast('Failed to save worker', 'error');
    }
  };

  const deactivate = async (id: string) => {
    if (!confirm('Deactivate this worker?')) return;
    try {
      const res = await fetch(`/api/workers?id=${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to deactivate worker');
      toast('Worker deactivated');
      fetchWorkers();
    } catch {
      toast('Failed to deactivate worker', 'error');
    }
  };

  // Admin-only: irreversibly deletes the face template + enrollment photos and
  // deactivates the worker so kiosks drop the cached template on next sync.
  const purgeBiometrics = async (w: Worker) => {
    const reason = window.prompt(
      `Permanently delete ${w.name}'s face template and enrollment photos?\n\n` +
      'This also deactivates the worker; kiosks drop the cached template on their next successful sync. ' +
      'This cannot be undone.\n\nEnter a reason (required):',
    );
    if (reason === null) return;
    if (!reason.trim()) {
      toast('A reason is required to purge face data', 'error');
      return;
    }
    try {
      const res = await fetch('/api/workers/purge-biometrics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: w.id, reason: reason.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || 'Failed to purge face data');
      }
      toast(`${w.name}'s face data purged and worker deactivated`);
      fetchWorkers();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to purge face data', 'error');
    }
  };

  const startEdit = (w: Worker) => {
    setEditId(w.id);
    setName(w.name);
    setEmployeeId(w.employee_id || '');
    setDepartment(w.department);
  };

  const enrolledCount = workers.filter(hasFaceEncoding).length;
  const invalidFaceCount = workers.filter((worker) => getEncodingStatus(worker) === 'invalid').length;
  const missingFaceCount = workers.filter((worker) => getEncodingStatus(worker) === 'missing').length;
  const departments = Array.from(new Set(workers.map((worker) => worker.department).filter(Boolean))).sort();
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const filteredWorkers = workers
    .filter((worker) => statusFilter === 'all' || getEncodingStatus(worker) === statusFilter)
    .filter((worker) => departmentFilter === 'all' || worker.department === departmentFilter)
    .filter((worker) => !normalizedSearch || `${worker.name} ${worker.employee_id || ''} ${worker.department || ''}`.toLocaleLowerCase().includes(normalizedSearch))
    .sort((left, right) => {
      if (sortBy === 'status') return getEncodingStatus(left).localeCompare(getEncodingStatus(right)) || left.name.localeCompare(right.name);
      if (sortBy === 'employee_id') return (left.employee_id || '').localeCompare(right.employee_id || '', undefined, { numeric: true }) || left.name.localeCompare(right.name);
      return left.name.localeCompare(right.name);
    });

  return (
    <div className="animate-fade-in">
      <div className="flex items-start justify-between mb-8 flex-wrap gap-4">
        <div>
          <h1 className="page-title text-slate-100">
            Worker <span className="text-gold">Management</span>
          </h1>
          <p className="text-sm text-slate-500 mt-1 font-mono">
            {workers.length} registered workers · {enrolledCount} face enrolled · {missingFaceCount} needs enrollment · {invalidFaceCount} invalid
          </p>
          {!canEdit && (
            <p className="mt-2 flex items-center gap-2">
              <span className="badge border border-slate-400/15 bg-slate-400/5 text-[10px] text-slate-300">Review-only</span>
              <span className="text-xs text-slate-500">Editing worker records requires an admin account.</span>
            </p>
          )}
        </div>
        {canEnroll && (
          <div className="flex gap-3 flex-wrap">
            <Link href="/enroll" className="btn-primary flex items-center gap-2">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              Enroll Face
            </Link>
          </div>
        )}
      </div>

      {canEdit && (
        <label className="mb-5 flex items-center gap-3 text-sm text-slate-300">
          <input type="checkbox" checked={showInactive} onChange={(event) => { setShowInactive(event.target.checked); resetEdit(); }} />
          Show inactive workers to review or purge retained face data
        </label>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-8">
        <div className="glass-card p-4">
          <p className="section-label">Recognition ready</p>
          <div className="mt-2 flex items-end gap-2">
            <span className="text-3xl font-display font-bold text-emerald-400">{enrolledCount}</span>
            <span className="pb-1 text-sm text-slate-500">workers</span>
          </div>
          <p className="mt-2 text-xs text-slate-500">Face enrolled and ready for kiosk recognition.</p>
        </div>
        <div className="glass-card p-4">
          <p className="section-label">Needs enrollment</p>
          <div className="mt-2 flex items-end gap-2">
            <span className={`text-3xl font-display font-bold ${missingFaceCount > 0 ? 'text-amber-400' : 'text-slate-500'}`}>{missingFaceCount}</span>
            <span className="pb-1 text-sm text-slate-500">workers</span>
          </div>
          <p className="mt-2 text-xs text-slate-500">Missing face data; use Enroll Face before kiosk use.</p>
        </div>
        <div className="glass-card p-4">
          <p className="section-label">Invalid face data</p>
          <div className="mt-2 flex items-end gap-2">
            <span className={`text-3xl font-display font-bold ${invalidFaceCount > 0 ? 'text-red-400' : 'text-slate-500'}`}>{invalidFaceCount}</span>
            <span className="pb-1 text-sm text-slate-500">workers</span>
          </div>
          <p className="mt-2 text-xs text-slate-500">Needs re-enrollment before kiosk recognition is reliable.</p>
        </div>
        <div className="glass-card p-4 border-l-4 border-gold/70">
          <p className="section-label">Canonical workflow</p>
          <h2 className="mt-2 font-display font-semibold text-gold">Adding a new person?</h2>
          <p className="mt-2 text-xs text-slate-400 leading-5">
            Use <span className="text-slate-200 font-semibold">Enroll Face</span> for all new facial-recognition enrollments.
          </p>
        </div>
      </div>

      {editId && (
        <div className="glass-card p-6 mb-8 animate-slide-up">
          <h2 className="font-display font-semibold text-gold mb-4 flex items-center gap-2">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
            </svg>
            Edit Worker Details
          </h2>
          <div className="space-y-4">
            <div>
              <label className="section-label mb-1.5 block">Full Name</label>
              <input placeholder="e.g. John Smith" value={name} onChange={(e) => setName(e.target.value)} className="input-field" />
            </div>
            <div>
              <label className="section-label mb-1.5 block">Employee ID Number</label>
              <input placeholder="e.g. F-2" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className="input-field" />
            </div>
            <div>
              <label className="section-label mb-1.5 block">Department</label>
              <input placeholder="e.g. Production, QC, Electrical" value={department} onChange={(e) => setDepartment(e.target.value)} className="input-field" />
            </div>
            <div className="flex gap-3 flex-wrap">
              <button onClick={handleSubmit} className="btn-primary">Save Changes</button>
              <button onClick={resetEdit} className="btn-secondary">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {!loading && workers.length > 0 && (
        <div className="glass-card mb-6 p-4">
          <div className="grid gap-3 lg:grid-cols-[minmax(240px,1fr)_180px_180px_140px_auto]">
            <div>
              <label htmlFor="worker-search" className="section-label mb-1.5 block">Search employees</label>
              <input
                id="worker-search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Name, ID, or department"
                className="input-field"
              />
            </div>
            <div>
              <label htmlFor="worker-status" className="section-label mb-1.5 block">Enrollment status</label>
              <select id="worker-status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)} className="input-field">
                <option value="all">All statuses</option>
                <option value="missing">Needs enrollment</option>
                <option value="valid">Face enrolled</option>
                <option value="invalid">Invalid face data</option>
              </select>
            </div>
            <div>
              <label htmlFor="worker-department" className="section-label mb-1.5 block">Department</label>
              <select id="worker-department" value={departmentFilter} onChange={(event) => setDepartmentFilter(event.target.value)} className="input-field">
                <option value="all">All departments</option>
                {departments.map((departmentName) => <option key={departmentName} value={departmentName}>{departmentName}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="worker-sort" className="section-label mb-1.5 block">Sort by</label>
              <select id="worker-sort" value={sortBy} onChange={(event) => setSortBy(event.target.value as typeof sortBy)} className="input-field">
                <option value="name">Name</option>
                <option value="employee_id">Employee ID</option>
                <option value="status">Status</option>
              </select>
            </div>
            <div className="flex items-end gap-1" aria-label="Worker view">
              <button type="button" onClick={() => setViewMode('cards')} className={`rounded-lg border px-3 py-2.5 text-xs font-semibold ${viewMode === 'cards' ? 'border-gold/50 bg-gold/15 text-gold' : 'border-navy-600 text-slate-400'}`}>Cards</button>
              <button type="button" onClick={() => setViewMode('table')} className={`rounded-lg border px-3 py-2.5 text-xs font-semibold ${viewMode === 'table' ? 'border-gold/50 bg-gold/15 text-gold' : 'border-navy-600 text-slate-400'}`}>Compact</button>
            </div>
          </div>
          <p className="mt-3 text-xs text-slate-500">Showing {filteredWorkers.length} of {workers.length} registered workers</p>
        </div>
      )}

      {error && (
        <div role="alert" className="mb-6 rounded-xl border border-red-400/20 bg-red-400/5 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <div className="glass-card p-6 text-sm text-slate-400">Loading workers...</div>
      ) : !error && workers.length === 0 ? (
        <div className="glass-card p-12 text-center">
          <p className="text-slate-400 font-display">{showInactive ? 'No inactive workers' : 'No workers registered yet'}</p>
          <p className="text-xs text-slate-600 mt-1">Use Enroll Face to add the first worker.</p>
        </div>
      ) : filteredWorkers.length === 0 ? (
        <div className="glass-card p-10 text-center text-sm text-slate-400">No workers match these filters.</div>
      ) : viewMode === 'cards' ? (
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {filteredWorkers.map((w, i) => {
          const encodingStatus = getEncodingStatus(w);
          const faceReady = encodingStatus === 'valid';
          const faceInvalid = encodingStatus === 'invalid';
          const statusLabel = faceReady ? 'Face enrolled' : faceInvalid ? 'Invalid face data' : 'Missing face';
          const readinessLabel = !w.active ? 'Inactive — excluded from kiosk recognition' : faceReady ? 'Ready for kiosk recognition' : faceInvalid ? 'Needs re-enrollment' : 'Needs enrollment';
          const readinessDetail = !w.active ? 'Purge retained face data here. To restore a returning worker, enroll them again using the same employee ID.' : faceReady
            ? 'This worker has valid face data and will sync to kiosks.'
            : faceInvalid
              ? 'This worker has face data, but it is not a supported kiosk vector. Re-enroll from photos.'
              : 'Capture photos in Enroll Face before this person can be recognized.';
          return (
            <div key={w.id} className={`glass-card-hover p-4 flex flex-col gap-4 animate-fade-in stagger-${Math.min(i + 1, 6)}`}>
              <div className="flex items-start gap-4">
                <div className={`w-12 h-12 rounded-2xl border flex items-center justify-center text-sm font-display font-bold shrink-0 ${faceReady ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-400' : faceInvalid ? 'bg-red-400/10 border-red-400/20 text-red-400' : 'bg-amber-400/10 border-amber-400/20 text-amber-400'}`}>
                  {getInitials(w.name)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-display font-semibold text-sm text-slate-200 truncate">{w.name}</div>
                  <div className="text-xs font-mono text-slate-500 truncate">ID: {w.employee_id || 'Not set'}</div>
                  <div className="text-xs font-mono text-slate-500 truncate">{w.department || 'No department'}</div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <span className="badge border bg-emerald-400/10 text-emerald-400 border-emerald-400/20">{w.active ? 'Active' : 'Inactive'}</span>
                    <span className={`badge border ${faceReady ? 'bg-emerald-400/10 text-emerald-400 border-emerald-400/20' : faceInvalid ? 'bg-red-400/10 text-red-400 border-red-400/20' : 'bg-amber-400/10 text-amber-400 border-amber-400/20'}`}>
                      {statusLabel}
                    </span>
                  </div>
                </div>
              </div>
              <div className="rounded-2xl border border-navy-600/40 bg-navy-900/45 px-3 py-2">
                <p className="text-xs font-medium text-slate-300">{readinessLabel}</p>
                <p className="mt-1 text-[11px] text-slate-500 leading-4">
                  {readinessDetail}
                </p>
              </div>
              <div className="flex gap-2 pt-1">
                {canEdit && Boolean(w.active) && (
                  <button onClick={() => startEdit(w)} className="btn-secondary flex-1 text-xs">Edit</button>
                )}
                {canEnroll && Boolean(w.active) ? (
                  <Link href={`/enroll?worker_id=${encodeURIComponent(w.id)}`} className={`flex-1 text-center text-xs ${faceReady ? 'btn-ghost' : 'btn-primary'}`}>
                    {faceReady ? 'Re-enroll' : faceInvalid ? 'Re-enroll' : 'Enroll now'}
                  </Link>
                ) : (
                  <button type="button" className="btn-secondary flex-1 text-xs" disabled>
                    Review-only
                  </button>
                )}
                {canEdit && Boolean(w.active) && (
                  <button onClick={() => deactivate(w.id)} className="px-3 py-2 text-xs rounded-xl bg-red-400/5 border border-red-400/10 text-red-400 hover:bg-red-400/10 transition-all">
                    Deactivate
                  </button>
                )}
                {canEdit && (
                  <button
                    onClick={() => purgeBiometrics(w)}
                    title="Permanently delete face template and photos, then deactivate"
                    className="px-3 py-2 text-xs rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 hover:bg-red-500/20 transition-all"
                  >
                    Purge face data
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      ) : (
        <div className="glass-card overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-navy-600 text-xs uppercase tracking-wide text-slate-500">
              <tr><th className="px-4 py-3">Employee</th><th className="px-4 py-3">ID</th><th className="px-4 py-3">Department</th><th className="px-4 py-3">Status</th><th className="px-4 py-3 text-right">Actions</th></tr>
            </thead>
            <tbody className="divide-y divide-navy-700/60">
              {filteredWorkers.map((worker) => {
                const encodingStatus = getEncodingStatus(worker);
                const statusLabel = !worker.active ? 'Inactive' : encodingStatus === 'valid' ? 'Face enrolled' : encodingStatus === 'invalid' ? 'Invalid face data' : 'Needs enrollment';
                return (
                  <tr key={worker.id} className="hover:bg-navy-800/50">
                    <td className="px-4 py-3 font-semibold text-slate-200">{worker.name}</td>
                    <td className="px-4 py-3 font-mono text-slate-400">{worker.employee_id || 'Not set'}</td>
                    <td className="px-4 py-3 text-slate-400">{worker.department || 'No department'}</td>
                    <td className="px-4 py-3"><span className={`badge border ${encodingStatus === 'valid' ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-400' : encodingStatus === 'invalid' ? 'border-red-400/20 bg-red-400/10 text-red-400' : 'border-amber-400/20 bg-amber-400/10 text-amber-400'}`}>{statusLabel}</span></td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        {canEdit && Boolean(worker.active) && <button onClick={() => startEdit(worker)} className="btn-ghost text-xs">Edit</button>}
                        {canEnroll && Boolean(worker.active) && <Link href={`/enroll?worker_id=${encodeURIComponent(worker.id)}`} className={encodingStatus === 'valid' ? 'btn-ghost text-xs' : 'btn-primary text-xs'}>{encodingStatus === 'missing' ? 'Enroll' : 'Re-enroll'}</Link>}
                        {canEdit && Boolean(worker.active) && <button onClick={() => deactivate(worker.id)} className="rounded-lg border border-red-400/20 px-2 py-1 text-xs text-red-400 hover:bg-red-400/10">Deactivate</button>}
                        {canEdit && <button onClick={() => purgeBiometrics(worker)} title="Permanently delete face template and photos, then deactivate" className="rounded-lg border border-red-500/30 bg-red-500/10 px-2 py-1 text-xs text-red-300 hover:bg-red-500/20">Purge face data</button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
