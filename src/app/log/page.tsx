'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import AttendanceTable, { attendanceRowId } from '@/components/AttendanceTable';
import { useToast } from '@/components/Toast';
import { AttendanceCorrection, AttendanceCorrectionsResponse, AttendanceWithWorker } from '@/lib/types';
import { getFactoryLocalDateString } from '@/lib/date';
import { buildHoursExportRows } from '@/lib/attendance-hours';
import { usePortalRole } from '@/hooks/usePortalRole';
import { correctionRequestId, acknowledgeCorrectionRequest } from '@/lib/correction-request';

function correctionLabel(action: string) {
  return action.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function correctionTimestamp(correction: AttendanceCorrection) {
  return correction.corrected_timestamp || correction.original_timestamp || correction.created_at;
}

function validDateParam(value: string | null) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function LogPageContent() {
  const { toast } = useToast();
  const role = usePortalRole();
  const canReverse = role === 'admin' || role === 'enrollment';
  const searchParams = useSearchParams();
  const queryDate = validDateParam(searchParams.get('date')) || getFactoryLocalDateString();
  const queryWorkerId = searchParams.get('worker_id') || '';
  const queryAttendanceId = searchParams.get('attendance_id') || '';
  const [date, setDate] = useState(queryDate);
  const [events, setEvents] = useState<AttendanceWithWorker[]>([]);
  const [corrections, setCorrections] = useState<AttendanceCorrection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Which date/worker selection the rows in `events` were fetched for. The
  // fetch effect runs after paint, so `loading` alone leaves one render where
  // a new selection still shows (and could export) the previous rows.
  const [loadedSelection, setLoadedSelection] = useState('');
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [reversalDraft, setReversalDraft] = useState<{ correction: AttendanceCorrection; reason: string; selection: string } | null>(null);
  const [reversing, setReversing] = useState(false);
  const reversalPendingRef = useRef(false);
  const selectionKey = `${date}|${queryWorkerId}|${refreshVersion}`;
  const visibleDraft = reversalDraft?.selection === selectionKey ? reversalDraft : null;
  const exportsReady = !loading && !error && loadedSelection === selectionKey;
  const hasSourceContext = Boolean(queryWorkerId || queryAttendanceId);
  const fullDayHref = `/log?date=${encodeURIComponent(date)}`;

  useEffect(() => {
    setReversalDraft(null);
    setDate(queryDate);
  }, [queryDate]);

  useEffect(() => {
    setReversalDraft(null);
  }, [queryWorkerId]);

  useEffect(() => {
    const attendanceParams = new URLSearchParams({ date });
    const correctionParams = new URLSearchParams({ date });
    if (queryWorkerId) {
      attendanceParams.set('worker_id', queryWorkerId);
      correctionParams.set('worker_id', queryWorkerId);
    }

    let cancelled = false;
    const fetchLog = async () => {
      setLoading(true);
      setError('');
      try {
        const [attendanceRes, correctionsRes] = await Promise.all([
          fetch(`/api/attendance?${attendanceParams.toString()}`),
          fetch(`/api/attendance-corrections?${correctionParams.toString()}`),
        ]);
        if (!attendanceRes.ok || !correctionsRes.ok) throw new Error('Failed to load activity log');
        const eventRows: AttendanceWithWorker[] = await attendanceRes.json();
        const correctionPayload: AttendanceCorrectionsResponse = await correctionsRes.json();
        if (cancelled) return;
        setEvents(Array.isArray(eventRows) ? eventRows : []);
        setCorrections(Array.isArray(correctionPayload.corrections) ? correctionPayload.corrections : []);
        setLoadedSelection(`${date}|${queryWorkerId}|${refreshVersion}`);
      } catch (err) {
        if (cancelled) return;
        setEvents([]);
        setCorrections([]);
        setError(err instanceof Error ? err.message : 'Failed to load activity log');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchLog();
    return () => {
      cancelled = true;
    };
  }, [date, queryWorkerId, refreshVersion]);

  async function submitReversal() {
    if (!canReverse || !visibleDraft || reversalPendingRef.current || !exportsReady) return;
    const reason = visibleDraft.reason.trim();
    if (!reason || reason.length > 1000) {
      toast('Enter a reversal reason of 1 to 1,000 characters', 'error');
      return;
    }
    const request = { correction_id: visibleDraft.correction.id, reason };
    reversalPendingRef.current = true;
    setReversing(true);
    try {
      const response = await fetch('/api/attendance-corrections', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...request, request_id: correctionRequestId(request) }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error || 'Failed to reverse correction');
      acknowledgeCorrectionRequest(request);
      setReversalDraft(null);
      setRefreshVersion((version) => version + 1);
      toast('Correction reversed');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Failed to reverse correction', 'error');
    } finally {
      reversalPendingRef.current = false;
      setReversing(false);
    }
  }

  useEffect(() => {
    if (!queryAttendanceId || !events.some((event) => event.id === queryAttendanceId)) return;
    document.getElementById(attendanceRowId(queryAttendanceId))?.scrollIntoView({ block: 'center' });
  }, [events, queryAttendanceId]);

  // Quote/escape a value for CSV so names or departments containing commas,
  // quotes, or newlines cannot shift columns in the exported file.
  const csvField = (value: unknown) => {
    const text = String(value ?? '');
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const downloadCSV = (content: string, filename: string) => {
    const blob = new Blob([content], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportCSV = () => {
    const header = 'Time,Worker,Department,Event,Kiosk,Source,Correction Reason,Note\n';
    const rows = events.map((e) =>
      [e.timestamp, e.worker_name, e.worker_department, e.event_type, e.kiosk_name || '', e.source || 'kiosk', e.correction_reason || '', e.note || ''].map(csvField).join(',')
    ).join('\n');
    downloadCSV(header + rows, `gatekeeper-${date}.csv`);
  };

  const exportHoursCSV = async () => {
    // Pair clock_in/clock_out events per worker in timestamp order. Shifts
    // that start on the selected date may end after midnight, so the next
    // day's events are fetched too and intervals are attributed to the day
    // the clock-in happened. A truly open interval (still clocked in) is
    // reported with an empty Out and 0 hours rather than a guess.
    // Without the boundary day, overnight shifts would silently export as
    // still-clocked-in with zero hours - refuse to produce bad payroll data.
    let boundaryEvents: AttendanceWithWorker[] = [];
    try {
      const next = new Date(`${date}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      const nextDate = next.toISOString().slice(0, 10);
      const params = new URLSearchParams({ date: nextDate });
      if (queryWorkerId) params.set('worker_id', queryWorkerId);
      const res = await fetch(`/api/attendance?${params.toString()}`);
      if (!res.ok) throw new Error(`next-day fetch failed (${res.status})`);
      const rows = await res.json();
      if (!Array.isArray(rows)) throw new Error('next-day fetch returned an unexpected payload');
      boundaryEvents = rows;
    } catch {
      toast('Could not load the next day\u2019s events, so overnight hours would be wrong. Export cancelled - try again.', 'error');
      return;
    }

    const hoursRows = buildHoursExportRows(events, boundaryEvents, date);
    if (hoursRows.some((row) => row.ambiguous)) {
      toast('Some workers need review: a next-day clock-in has no preceding clock-out. Their hours are blank in the CSV.', 'info');
    }
    const rows = hoursRows.map((row) =>
      [row.name, row.department, row.firstIn, row.lastOut, row.hours, row.note].map(csvField).join(',')
    );

    const header = 'Worker,Department,First In,Last Out,Hours,Note\n';
    downloadCSV(header + rows.join('\n'), `gatekeeper-hours-${date}.csv`);
  };

  return (
    <div className="animate-fade-in">
      <div className="flex items-start justify-between mb-8 flex-wrap gap-4">
        <div>
          <h1 className="page-title text-slate-100">
            Activity <span className="text-gold">Log</span>
          </h1>
          <p className="text-sm text-slate-500 mt-1 font-mono">
            {events.length} effective events · {corrections.length} correction{corrections.length === 1 ? '' : 's'}
            {queryWorkerId ? ' · worker filtered' : ''}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="date"
            value={date}
            onChange={(e) => { setReversalDraft(null); setDate(e.target.value); }}
            className="input-field w-auto"
          />
          <button
            onClick={exportHoursCSV}
            disabled={!exportsReady}
            className="btn-secondary flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Export hours CSV
          </button>
          <button
            onClick={exportCSV}
            disabled={!exportsReady}
            className="btn-primary flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
            Export CSV
          </button>
        </div>
      </div>

      {hasSourceContext && (
        <div className="glass-card mb-6 flex flex-col gap-4 border-l-4 border-gold/70 px-5 py-4 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="section-label text-gold">Source-linked view</div>
            <div className="mt-2 flex flex-wrap gap-2 text-xs font-mono text-slate-400">
              {queryWorkerId && (
                <span className="rounded border border-navy-500/70 bg-navy-900/60 px-2 py-1">
                  worker {queryWorkerId}
                </span>
              )}
              {queryAttendanceId && (
                <span className="rounded border border-gold/30 bg-gold/10 px-2 py-1 text-gold">
                  event {queryAttendanceId}
                </span>
              )}
            </div>
          </div>
          <Link href={fullDayHref} className="btn-secondary self-start text-xs md:self-auto">
            Full day
          </Link>
        </div>
      )}

      {error && (
        <div role="alert" className="mb-6 rounded-xl border border-red-400/20 bg-red-400/5 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {loading || loadedSelection !== selectionKey ? (
        <div className="glass-card p-6 text-sm text-slate-400">Loading activity log...</div>
      ) : error ? null : (
      <>
      <div className="glass-card overflow-hidden">
        <AttendanceTable events={events} targetAttendanceId={queryAttendanceId} />
      </div>

      <section className="glass-card mt-6 overflow-hidden">
        <div className="border-b border-navy-600/50 px-5 py-4">
          <h2 className="font-display font-semibold text-slate-100">Correction history</h2>
          <p className="mt-1 text-xs text-slate-500">Audited supervisor changes applied to the effective attendance record.</p>
        </div>
        {corrections.length === 0 ? (
          <div className="px-5 py-6 text-sm text-slate-500">No attendance corrections recorded for this date.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-navy-600/50">
                  <th className="px-5 py-3.5 text-left section-label">Correction</th>
                  <th className="px-5 py-3.5 text-left section-label">Worker</th>
                  <th className="px-5 py-3.5 text-left section-label">Effective Time</th>
                  <th className="px-5 py-3.5 text-left section-label">Reason</th>
                  <th className="px-5 py-3.5 text-left section-label">Supervisor</th>
                  {canReverse && <th className="px-5 py-3.5 text-left section-label">Action</th>}
                </tr>
              </thead>
              <tbody>
                {corrections.map((correction) => (
                  <tr key={correction.id} className="border-b border-navy-700/30 table-row-hover">
                    <td className="px-5 py-3">
                      <span className="badge border border-gold/20 bg-gold/10 text-gold text-[11px]">{correctionLabel(correction.action)}</span>
                      {correction.reversal_id && <span className="ml-2 text-xs text-amber-300">Reversed</span>}
                    </td>
                    <td className="px-5 py-3">
                      <div className="font-display font-medium text-slate-200">{correction.worker_name || correction.worker_id}</div>
                      <div className="text-[11px] font-mono text-slate-500">{correction.worker_department}</div>
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-slate-400">
                      {new Date(correctionTimestamp(correction)).toLocaleString()}
                    </td>
                    <td className="px-5 py-3 text-slate-400">
                      {correction.reason}
                      {correction.reversal_id && <div className="mt-1 text-amber-200">Reversal: {correction.reversal_reason} · {correction.reversed_at ? new Date(correction.reversed_at).toLocaleString() : ''}</div>}
                    </td>
                    <td className="px-5 py-3 text-xs text-slate-500">
                      {correction.supervisor_name || 'Not recorded'}
                      {correction.actor_user_id && <div>Actor: {correction.actor_name || correction.actor_user_id}</div>}
                      {correction.reversed_by_user_id && <div>Reversed by: {correction.reversed_by_name || correction.reversed_by_user_id}</div>}
                    </td>
                    {canReverse && <td className="px-5 py-3">
                      {!correction.reversal_id && <button type="button" className="btn-secondary text-xs" disabled={reversing} onClick={() => setReversalDraft({ correction, reason: '', selection: selectionKey })}>Reverse</button>}
                    </td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {canReverse && visibleDraft && (
          <div className="border-t border-navy-600/50 p-5">
            <label htmlFor="reversal-reason" className="section-label mb-2 block">Reason for reversal</label>
            <p className="mb-3 text-sm text-slate-300">
              {visibleDraft.correction.worker_name || visibleDraft.correction.worker_id} · {visibleDraft.correction.date} · {correctionLabel(visibleDraft.correction.action)}
              <span className="block mt-1 font-mono text-xs text-slate-400">Correction {visibleDraft.correction.id}{visibleDraft.correction.original_attendance_id ? ` · Raw event ${visibleDraft.correction.original_attendance_id}` : ''}</span>
              <span className="block mt-1">Original reason: {visibleDraft.correction.reason}</span>
            </p>
            <textarea id="reversal-reason" value={visibleDraft.reason} maxLength={1000} onChange={(event) => setReversalDraft({ ...visibleDraft, reason: event.target.value })} className="input-field w-full" rows={3} placeholder="Explain why this correction should no longer affect attendance" />
            <div className="mt-3 flex gap-2">
              <button type="button" className="btn-primary" disabled={reversing || !visibleDraft.reason.trim() || !exportsReady} onClick={() => void submitReversal()}>{reversing ? 'Reversing…' : 'Confirm reversal'}</button>
              <button type="button" className="btn-secondary" disabled={reversing} onClick={() => setReversalDraft(null)}>Cancel</button>
            </div>
          </div>
        )}
      </section>
      </>
      )}
    </div>
  );
}

export default function LogPage() {
  return (
    <Suspense fallback={null}>
      <LogPageContent />
    </Suspense>
  );
}
