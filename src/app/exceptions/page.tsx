'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useToast } from '@/components/Toast';
import { correctionRequestId, acknowledgeCorrectionRequest } from '@/lib/correction-request';
import { createLocalIsoTimestamp, getFactoryLocalDateString } from '@/lib/date';
import { usePortalRole } from '@/hooks/usePortalRole';
import { useSelectedData } from '@/hooks/useSelectedData';
import {
  AttendanceCorrectionAction,
  ShiftException,
  ShiftExceptionsResponse,
  ShiftExceptionSeverity,
  ShiftExceptionStatus,
} from '@/lib/types';

const typeLabels: Record<string, string> = {
  missing_arrival: 'Missing arrival',
  late_arrival: 'Late arrival',
  missing_clock_out: 'Still clocked in',
  scan_sequence: 'Bad scan sequence',
  recognition_review: 'Recognition review',
};

const severityStyles: Record<ShiftExceptionSeverity, string> = {
  critical: 'bg-red-400/10 text-red-300 border-red-400/20',
  warning: 'bg-amber-400/10 text-amber-300 border-amber-400/20',
  info: 'bg-blue-400/10 text-blue-300 border-blue-400/20',
};

const statusStyles: Record<ShiftExceptionStatus, string> = {
  open: 'bg-gold/10 text-gold border-gold/20',
  reviewed: 'bg-blue-400/10 text-blue-300 border-blue-400/20',
  ignored: 'bg-slate-400/10 text-slate-300 border-slate-400/20',
  resolved: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/20',
};

type CorrectionDraft = {
  exception: ShiftException;
  action: AttendanceCorrectionAction;
  correctedTime: string;
  suggestedCorrectedTime: string;
  originalAttendanceId: string | null;
  sourceExceptionKey: string;
  sourceHref: string | null;
  reason: string;
  reasonWasSuggested: boolean;
  supervisorName: string;
};

type PortalRole = 'admin' | 'enrollment' | 'viewer' | string;

function titleCase(value: string) {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDateTime(value: string | null) {
  if (!value) return 'No scan';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function escapeCsv(value: unknown) {
  const text = String(value ?? '');
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function isAttendanceCorrectionAction(action: ShiftException['suggested_resolution']['action']): action is AttendanceCorrectionAction {
  return action === 'add_clock_in' || action === 'add_clock_out' || action === 'void_event';
}

function canCorrectException(exception: ShiftException) {
  const resolution = exception.suggested_resolution;
  return resolution.can_apply && isAttendanceCorrectionAction(resolution.action);
}

function suggestedReviewNotes(exception: ShiftException) {
  const worker = exception.worker_name || 'Unknown worker';
  const issue = typeLabels[exception.type] || titleCase(exception.type);
  const source = `Source exception ${exception.key}.`;
  const resolution = exception.suggested_resolution;
  const notes = [
    {
      label: resolution.label,
      note: resolution.reason,
    },
  ];

  if (resolution.href) {
    notes.push({
      label: 'Source reviewed',
      note: `${issue}: supervisor reviewed source evidence for ${worker}. ${source}`,
    });
  }

  notes.push({
    label: 'No correction needed',
    note: `${issue}: no attendance correction needed after supervisor review for ${worker}. ${source}`,
  });

  return notes;
}

function appendReviewNote(existingNote: string, suggestion: string) {
  const current = existingNote.trim();
  if (!current) return suggestion;
  if (current.includes(suggestion)) return current;
  return `${current}\n${suggestion}`;
}

function timestampFor(date: string, time: string) {
  return createLocalIsoTimestamp(date, time);
}

function csvFor(exceptions: ShiftException[]) {
  const headers = [
    'Status',
    'Severity',
    'Type',
    'Worker',
    'Department',
    'Kiosk',
    'First Seen',
    'Last Seen',
    'Schedule',
    'Scheduled Start',
    'Scheduled End',
    'Description',
    'Note',
  ];
  const rows = exceptions.map((exception) => [
    exception.status,
    exception.severity,
    typeLabels[exception.type] || titleCase(exception.type),
    exception.worker_name || '',
    exception.department || '',
    exception.kiosk_name || exception.kiosk_id || '',
    exception.first_seen || '',
    exception.last_seen || '',
    exception.schedule_name || '',
    exception.scheduled_start || '',
    exception.scheduled_end || '',
    exception.description,
    exception.review_note || '',
  ]);
  return [headers, ...rows].map((row) => row.map(escapeCsv).join(',')).join('\n');
}

function validDateParam(value: string | null) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function validSeverityParam(value: string | null): ShiftExceptionSeverity | 'all' {
  return value === 'critical' || value === 'warning' || value === 'info' ? value : 'all';
}

function validStatusParam(value: string | null): ShiftExceptionStatus | 'all' {
  return value === 'open' || value === 'reviewed' || value === 'resolved' || value === 'ignored' || value === 'all' ? value : 'open';
}

function canOperateExceptions(role: PortalRole | undefined) {
  return role === 'admin' || role === 'enrollment';
}

function exceptionRowId(key: string) {
  return `exception-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function ExceptionsPageContent() {
  const { toast } = useToast();
  const searchParams = useSearchParams();
  const queryDate = validDateParam(searchParams.get('date')) || getFactoryLocalDateString();
  const queryDepartment = searchParams.get('department') || 'all';
  const queryType = searchParams.get('type') || 'all';
  const querySeverity = validSeverityParam(searchParams.get('severity'));
  const queryStatus = validStatusParam(searchParams.get('status'));
  const queryExceptionKey = searchParams.get('exception_key') || '';
  const queryIntent = searchParams.get('intent') || '';
  const currentRole = usePortalRole();
  const [date, setDate] = useState(queryDate);
  const [department, setDepartment] = useState(queryDepartment);
  const [type, setType] = useState(queryType);
  const [severity, setSeverity] = useState<ShiftExceptionSeverity | 'all'>(querySeverity);
  const [status, setStatus] = useState<ShiftExceptionStatus | 'all'>(queryStatus);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [correctionDraft, setCorrectionDraft] = useState<CorrectionDraft | null>(null);
  const [handledIntentKey, setHandledIntentKey] = useState('');
  const [savingCorrection, setSavingCorrection] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const reviewPendingRef = useRef(false);
  const correctionPendingRef = useRef(false);
  const canOperate = canOperateExceptions(currentRole);
  const correctionModalRef = useRef<HTMLElement | null>(null);
  const correctionTriggerRef = useRef<HTMLElement | null>(null);
  const correctionOpen = correctionDraft !== null;

  useEffect(() => {
    setDate(queryDate);
    setDepartment(queryDepartment);
    setType(queryType);
    setSeverity(querySeverity);
    setStatus(queryStatus);
  }, [queryDate, queryDepartment, querySeverity, queryStatus, queryType]);

  const loadExceptions = useCallback(async (signal: AbortSignal): Promise<ShiftExceptionsResponse> => {
    const res = await fetch(`/api/shift-exceptions?date=${date}`, { cache: 'no-store', signal });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error || 'Failed to load exceptions');
    if (body.date !== date) throw new Error('The server returned a different shift date. Refresh to try again.');
    return body;
  }, [date]);
  const { data: payload, loading, error, refresh: fetchExceptions } = useSelectedData(date, loadExceptions);
  const dataReady = Boolean(payload && !loading && !error);


  useEffect(() => {
    setCorrectionDraft(null);
    setNoteDrafts({});
    setHandledIntentKey('');
  }, [date]);

  const exceptions = payload?.exceptions ?? [];
  const departments = useMemo(() => {
    const values = exceptions.flatMap((exception) => (exception.department ? [exception.department] : []));
    return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
  }, [exceptions]);
  const types = useMemo(() => {
    const values = exceptions.map((exception) => exception.type);
    return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
  }, [exceptions]);

  const filtered = useMemo(() => {
    return exceptions.filter((exception) => {
      const departmentMatches = department === 'all' || exception.department === department;
      const typeMatches = type === 'all' || exception.type === type;
      const severityMatches = severity === 'all' || exception.severity === severity;
      const statusMatches = status === 'all' || exception.status === status;
      return departmentMatches && typeMatches && severityMatches && statusMatches;
    });
  }, [department, exceptions, severity, status, type]);

  function updateReview(exception: ShiftException, nextStatus: ShiftExceptionStatus) {
    if (!canOperate) {
      toast('Only admin or enrollment roles can update exception reviews.', 'error');
      return;
    }
    if (!dataReady || exception.date !== date || reviewPendingRef.current || correctionPendingRef.current) return;
    reviewPendingRef.current = true;
    setIsPending(true);
    void (async () => {
      try {
        const res = await fetch('/api/shift-exceptions', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            exception_key: exception.key,
            date: exception.date,
            type: exception.type,
            status: nextStatus,
            note: noteDrafts[exception.key] || exception.review_note || undefined,
          }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error || 'Failed to update exception');
        toast(`Exception marked ${titleCase(nextStatus)}`);
        await fetchExceptions();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to update exception', 'error');
      } finally {
        reviewPendingRef.current = false;
        setIsPending(false);
      }
    })();
  }

  function openCorrection(exception: ShiftException) {
    if (!dataReady || exception.date !== date || reviewPendingRef.current) return;
    if (!canOperate) {
      toast('Only admin or enrollment roles can correct attendance.', 'error');
      return;
    }
    const resolution = exception.suggested_resolution;
    if (!canCorrectException(exception) || !isAttendanceCorrectionAction(resolution.action)) {
      toast(resolution.disabled_reason || 'This exception does not have a one-tap correction path.', 'error');
      return;
    }
    const existingReason = noteDrafts[exception.key] || exception.review_note || '';
    correctionTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setCorrectionDraft({
      exception,
      action: resolution.action,
      correctedTime: resolution.corrected_time || '',
      suggestedCorrectedTime: resolution.corrected_time || '',
      originalAttendanceId: resolution.original_attendance_id,
      sourceExceptionKey: resolution.source_exception_key,
      sourceHref: resolution.source_href,
      reason: existingReason || resolution.reason,
      reasonWasSuggested: !existingReason,
      supervisorName: '',
    });
  }

  function updateCorrectionTime(correctedTime: string) {
    setCorrectionDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        correctedTime,
      };
    });
  }

  function getCorrectionFocusables(): HTMLElement[] {
    if (!correctionModalRef.current) return [];
    return Array.from(
      correctionModalRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
  }

  useEffect(() => {
    if (!correctionOpen) return;
    const [firstFocusable] = getCorrectionFocusables();
    firstFocusable?.focus();
    return () => {
      correctionTriggerRef.current?.focus();
      correctionTriggerRef.current = null;
    };
  }, [correctionOpen]);

  function handleCorrectionKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (!savingCorrection) setCorrectionDraft(null);
      return;
    }
    if (event.key !== 'Tab') return;
    const focusables = getCorrectionFocusables();
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !correctionModalRef.current?.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !correctionModalRef.current?.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  function applySuggestedReviewNote(exception: ShiftException, note: string) {
    setNoteDrafts((current) => ({
      ...current,
      [exception.key]: appendReviewNote(current[exception.key] ?? exception.review_note ?? '', note),
    }));
  }

  useEffect(() => {
    if (!canOperate || !queryExceptionKey || queryIntent !== 'correct' || handledIntentKey === queryExceptionKey || correctionDraft) return;
    const target = filtered.find((exception) => exception.key === queryExceptionKey);
    if (!target || !canCorrectException(target) || target.status !== 'open') return;
    openCorrection(target);
    setHandledIntentKey(queryExceptionKey);
  }, [canOperate, correctionDraft, filtered, handledIntentKey, queryExceptionKey, queryIntent]);

  useEffect(() => {
    if (!queryExceptionKey || !filtered.some((exception) => exception.key === queryExceptionKey)) return;
    document.getElementById(exceptionRowId(queryExceptionKey))?.scrollIntoView({ block: 'center' });
  }, [filtered, queryExceptionKey]);

  async function submitCorrection() {
    if (!dataReady || correctionPendingRef.current || correctionDraft?.exception.date !== date) return;
    if (!canOperate) {
      toast('Only admin or enrollment roles can save attendance corrections.', 'error');
      return;
    }
    if (!correctionDraft?.exception.worker_id) return;
    if (!correctionDraft.reason.trim()) {
      toast('Correction reason required', 'error');
      return;
    }
    if (correctionDraft.action !== 'void_event' && !correctionDraft.correctedTime) {
      toast('Correction time required', 'error');
      return;
    }
    if (
      correctionDraft.action !== 'void_event' &&
      correctionDraft.reasonWasSuggested &&
      correctionDraft.correctedTime !== correctionDraft.suggestedCorrectedTime
    ) {
      toast('Update the correction reason after changing the suggested time.', 'error');
      return;
    }

    const request = {
      date,
      worker_id: correctionDraft.exception.worker_id,
      action: correctionDraft.action,
      corrected_timestamp: correctionDraft.action === 'void_event' ? undefined : timestampFor(date, correctionDraft.correctedTime),
      original_attendance_id: correctionDraft.action === 'void_event' ? correctionDraft.originalAttendanceId : undefined,
      related_exception_key: correctionDraft.sourceExceptionKey,
      reason: correctionDraft.reason.trim(),
      supervisor_name: correctionDraft.supervisorName.trim(),
    };

    correctionPendingRef.current = true;
    setSavingCorrection(true);
    try {
      const res = await fetch('/api/attendance-corrections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...request, request_id: correctionRequestId(request) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || 'Failed to save correction');
      acknowledgeCorrectionRequest(request);
      toast('Attendance correction saved');
      setCorrectionDraft(null);
      await fetchExceptions();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to save correction', 'error');
    } finally {
      correctionPendingRef.current = false;
      setSavingCorrection(false);
    }
  }

  function exportCsv() {
    if (!dataReady) return;
    const blob = new Blob([csvFor(filtered)], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gatekeeper-exceptions-${date}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const summary = payload?.summary;

  return (
    <div className="animate-fade-in space-y-6 pb-24 md:pb-8">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <p className="section-label mb-2">Supervisor workflow</p>
          <h1 className="page-title text-slate-100">
            Shift <span className="text-gold">Exceptions</span>
          </h1>
          <p className="text-sm text-slate-400 mt-2 max-w-2xl leading-6">
            Daily breakdown sheet for late arrivals, missing scans, bad scan sequences, and recognition reviews.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button type="button" onClick={fetchExceptions} className="btn-secondary" disabled={loading || isPending || savingCorrection}>
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
          <button type="button" onClick={exportCsv} className="btn-primary" disabled={!dataReady || filtered.length === 0}>
            Export CSV
          </button>
        </div>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {[
          ['Open', summary?.open ?? 0, 'text-gold'],
          ['Critical', summary?.critical ?? 0, 'text-red-300'],
          ['Warning', summary?.warning ?? 0, 'text-amber-300'],
          ['Info', summary?.info ?? 0, 'text-blue-300'],
          ['Filtered', filtered.length, 'text-slate-100'],
        ].map(([label, value, tone]) => (
          <div key={label} className="rounded-xl border border-navy-600/50 bg-navy-900/35 p-4">
            <p className="text-xs text-slate-500">{label}</p>
            <p className={`mt-1 font-display text-2xl ${tone}`}>{value}</p>
          </div>
        ))}
      </section>

      <section className="glass-card p-5">
        <div className="grid gap-3 md:grid-cols-5">
          <label className="space-y-1.5">
            <span className="section-label block">Date</span>
            <input type="date" disabled={isPending || savingCorrection} value={date} onChange={(event) => setDate(event.target.value)} className="input-field" />
          </label>
          <label className="space-y-1.5">
            <span className="section-label block">Department</span>
            <select value={department} onChange={(event) => setDepartment(event.target.value)} className="input-field">
              <option value="all">All departments</option>
              {departments.map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1.5">
            <span className="section-label block">Type</span>
            <select value={type} onChange={(event) => setType(event.target.value)} className="input-field">
              <option value="all">All types</option>
              {types.map((value) => (
                <option key={value} value={value}>{typeLabels[value] || titleCase(value)}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1.5">
            <span className="section-label block">Severity</span>
            <select value={severity} onChange={(event) => setSeverity(event.target.value as ShiftExceptionSeverity | 'all')} className="input-field">
              <option value="all">All severity</option>
              <option value="critical">Critical</option>
              <option value="warning">Warning</option>
              <option value="info">Info</option>
            </select>
          </label>
          <label className="space-y-1.5">
            <span className="section-label block">Status</span>
            <select value={status} onChange={(event) => setStatus(event.target.value as ShiftExceptionStatus | 'all')} className="input-field">
              <option value="all">All statuses</option>
              <option value="open">Open</option>
              <option value="reviewed">Reviewed</option>
              <option value="resolved">Resolved</option>
              <option value="ignored">Ignored</option>
            </select>
          </label>
        </div>
      </section>

      {error && (
        <div role="alert" className="rounded-xl border border-red-400/20 bg-red-400/5 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {payload?.backend_unavailable && (
        <div role="status" className="rounded-xl border border-amber-400/20 bg-amber-400/5 px-4 py-3 text-sm text-amber-200">
          {payload.warning || 'Shift exception storage is waiting for deployment.'}
        </div>
      )}

      {loading && !payload ? (
        <div className="glass-card p-6 text-sm text-slate-400">Loading shift exceptions...</div>
      ) : filtered.length === 0 ? (
        <div className="glass-card p-8 text-center">
          <h2 className="font-display text-xl text-slate-100">No exceptions in this view</h2>
          <p className="mt-2 text-sm text-slate-400">Adjust filters or pick another date to inspect the daily breakdown sheet.</p>
        </div>
      ) : (
        <section className="glass-card overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-navy-600/50 px-5 py-4">
            <div>
              <h2 className="font-display font-semibold text-slate-100">Exception queue</h2>
              <p className="text-xs font-mono text-slate-500">{filtered.length} rows in current view</p>
            </div>
            {loading && <span className="text-xs text-slate-500">Refreshing...</span>}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[1120px] text-left">
              <thead>
                <tr className="border-b border-navy-600/50 text-[11px] uppercase tracking-wider text-slate-500">
                  <th className="px-4 py-3 font-medium">Issue</th>
                  <th className="px-4 py-3 font-medium">Severity</th>
                  <th className="px-4 py-3 font-medium">Worker</th>
                  <th className="px-4 py-3 font-medium">Schedule</th>
                  <th className="px-4 py-3 font-medium">Last seen</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Note</th>
                  <th className="px-4 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-navy-600/35">
                {filtered.map((exception) => {
                  const controlsDisabled = !dataReady || isPending || savingCorrection;
                  const targeted = queryExceptionKey === exception.key;
                  const resolution = exception.suggested_resolution;
                  return (
                    <tr
                      id={exceptionRowId(exception.key)}
                      key={exception.key}
                      className={`align-top text-sm text-slate-300 hover:bg-navy-800/35 ${targeted ? 'bg-gold/5 ring-1 ring-inset ring-gold/30' : ''}`}
                    >
                      <td className="px-4 py-4">
                        <p className="font-medium text-slate-100">{exception.title}</p>
                        <p className="mt-1 max-w-lg text-xs leading-5 text-slate-500">{exception.description}</p>
                        <div className="mt-3 rounded-lg border border-navy-600/50 bg-navy-950/50 p-3">
                          <p className="text-[11px] uppercase tracking-wider text-slate-500">Suggested resolution</p>
                          <p className="mt-1 text-xs font-medium text-slate-200">{resolution.label}</p>
                          <p className="mt-1 text-xs leading-5 text-slate-500">
                            {resolution.disabled_reason || resolution.reason}
                          </p>
                          {resolution.href && (
                            <Link href={resolution.href} className="mt-2 inline-flex text-xs text-gold hover:text-gold-light">
                              {resolution.cta}
                            </Link>
                          )}
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <span className="badge border border-navy-600/50 bg-navy-900/60 text-slate-400">
                            {typeLabels[exception.type] || titleCase(exception.type)}
                          </span>
                          {exception.links.activity_log && (
                            <Link href={exception.links.activity_log} className="text-xs text-gold hover:text-gold-light">Activity</Link>
                          )}
                          {exception.links.recognition_lab && (
                            <Link href={exception.links.recognition_lab} className="text-xs text-gold hover:text-gold-light">Recognition Lab</Link>
                          )}
                          {exception.links.kiosk && (
                            <Link href={exception.links.kiosk} className="text-xs text-gold hover:text-gold-light">Kiosks</Link>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <span className={`badge border ${severityStyles[exception.severity]}`}>{titleCase(exception.severity)}</span>
                      </td>
                      <td className="px-4 py-4">
                        <p className="font-medium text-slate-100">{exception.worker_name || 'No worker'}</p>
                        <p className="mt-1 text-xs font-mono text-slate-500">{exception.department || 'No department'}</p>
                        {exception.kiosk_name || exception.kiosk_id ? (
                          <p className="mt-1 text-xs text-slate-500">{exception.kiosk_name || exception.kiosk_id}</p>
                        ) : null}
                      </td>
                      <td className="px-4 py-4">
                        <p className="text-sm text-slate-200">{exception.schedule_name || 'No schedule'}</p>
                        <p className="mt-1 text-xs font-mono text-slate-500">
                          {exception.scheduled_start || '--:--'} - {exception.scheduled_end || '--:--'}
                        </p>
                      </td>
                      <td className="px-4 py-4">
                        <p className="text-xs text-slate-400">{formatDateTime(exception.last_seen || exception.first_seen)}</p>
                        <p className="mt-1 text-xs font-mono text-slate-500">{exception.event_count} event{exception.event_count === 1 ? '' : 's'}</p>
                      </td>
                      <td className="px-4 py-4">
                        <span className={`badge border ${statusStyles[exception.status]}`}>{titleCase(exception.status)}</span>
                      </td>
                      <td className="px-4 py-4">
                        <textarea
                          rows={2}
                          value={noteDrafts[exception.key] ?? exception.review_note ?? ''}
                          onChange={(event) => {
                            if (!canOperate) return;
                            setNoteDrafts((current) => ({ ...current, [exception.key]: event.target.value }));
                          }}
                          placeholder={canOperate ? 'Optional note' : 'Review note'}
                          readOnly={!canOperate}
                          className="input-field min-h-[72px] min-w-[190px] resize-y text-xs"
                        />
                        {canOperate && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {suggestedReviewNotes(exception).map((suggestion) => (
                              <button
                                key={suggestion.label}
                                type="button"
                                className="rounded-full border border-navy-600/60 bg-navy-900/70 px-2.5 py-1 text-[10px] text-slate-300 hover:border-gold/40 hover:text-gold"
                                onClick={() => applySuggestedReviewNote(exception, suggestion.note)}
                              >
                                {suggestion.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex flex-col gap-2">
                          {canOperate ? (
                            <>
                              <button type="button" className="btn-secondary text-xs" disabled={controlsDisabled} onClick={() => updateReview(exception, 'reviewed')}>
                                Reviewed
                              </button>
                              <button type="button" className="btn-primary text-xs" disabled={controlsDisabled} onClick={() => updateReview(exception, 'resolved')}>
                                Resolved
                              </button>
                              {canCorrectException(exception) && (
                                <button type="button" className="btn-secondary text-xs" disabled={controlsDisabled} onClick={() => openCorrection(exception)}>
                                  {resolution.cta}
                                </button>
                              )}
                              {!canCorrectException(exception) && resolution.href && (
                                <Link href={resolution.href} className="btn-secondary text-xs">
                                  {resolution.cta}
                                </Link>
                              )}
                              <button type="button" className="btn-ghost text-xs" disabled={controlsDisabled} onClick={() => updateReview(exception, 'ignored')}>
                                Ignore
                              </button>
                              {exception.status !== 'open' && (
                                <button type="button" className="btn-ghost text-xs" disabled={controlsDisabled} onClick={() => updateReview(exception, 'open')}>
                                  Reopen
                                </button>
                              )}
                            </>
                          ) : (
                            resolution.href ? (
                              <Link href={resolution.href} className="btn-secondary text-xs">
                                Review source
                              </Link>
                            ) : (
                              <button type="button" className="btn-secondary text-xs" disabled>
                                Review-only
                              </button>
                            )
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {correctionDraft && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 px-4 py-6 backdrop-blur-sm md:items-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="correction-modal-title"
          onKeyDown={handleCorrectionKeyDown}
        >
          <section ref={correctionModalRef} className="w-full max-w-2xl rounded-2xl border border-navy-600/70 bg-navy-950 p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="section-label mb-2">Supervisor correction</p>
                <h2 id="correction-modal-title" className="font-display text-2xl text-slate-100">Correct attendance</h2>
                <p className="mt-2 text-sm leading-6 text-slate-400">{correctionDraft.exception.title}</p>
              </div>
              <button type="button" className="btn-ghost text-xs" onClick={() => setCorrectionDraft(null)} disabled={savingCorrection}>
                Close
              </button>
            </div>

            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <label className="space-y-1.5">
                <span className="section-label block">Worker</span>
                <input value={correctionDraft.exception.worker_name || 'Unknown worker'} readOnly className="input-field" />
              </label>
              <label className="space-y-1.5">
                <span className="section-label block">Action</span>
                <input
                  value={correctionDraft.exception.suggested_resolution.label}
                  readOnly
                  className="input-field"
                />
              </label>
              {correctionDraft.action !== 'void_event' ? (
                <label className="space-y-1.5">
                  <span className="section-label block">Corrected time</span>
                  <input
                    type="time"
                    value={correctionDraft.correctedTime}
                    onChange={(event) => updateCorrectionTime(event.target.value)}
                    className="input-field font-mono"
                  />
                </label>
              ) : (
                <div className="rounded-xl border border-amber-400/20 bg-amber-400/5 p-4 text-sm text-amber-100/85">
                  This will void raw event <span className="font-mono text-amber-100">{correctionDraft.originalAttendanceId}</span> from the effective attendance record. The kiosk row remains in the audit trail.
                </div>
              )}
              <label className="space-y-1.5">
                <span className="section-label block">Supervisor name</span>
                <input
                  value={correctionDraft.supervisorName}
                  onChange={(event) => setCorrectionDraft((current) => current ? { ...current, supervisorName: event.target.value } : current)}
                  placeholder="Optional"
                  className="input-field"
                />
              </label>
            </div>

            {correctionDraft.sourceHref && (
              <Link href={correctionDraft.sourceHref} className="mt-4 inline-flex text-xs text-gold hover:text-gold-light">
                Open source evidence
              </Link>
            )}

            <label className="mt-4 block space-y-1.5">
              <span className="section-label block">Correction reason</span>
              <textarea
                rows={4}
                value={correctionDraft.reason}
                onChange={(event) => setCorrectionDraft((current) => current ? { ...current, reason: event.target.value, reasonWasSuggested: false } : current)}
                placeholder="Required: document what the supervisor verified."
                className="input-field resize-y"
              />
            </label>

            <div className="mt-5 flex flex-wrap justify-end gap-3">
              <button type="button" className="btn-secondary" onClick={() => setCorrectionDraft(null)} disabled={savingCorrection}>
                Cancel
              </button>
              <button type="button" className="btn-primary" onClick={submitCorrection} disabled={savingCorrection || !correctionDraft.reason.trim()}>
                {savingCorrection ? 'Saving...' : 'Save correction'}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

export default function ExceptionsPage() {
  return (
    <Suspense fallback={null}>
      <ExceptionsPageContent />
    </Suspense>
  );
}
