'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { getFactoryLocalDateString } from '@/lib/date';
import { usePortalRole } from '@/hooks/usePortalRole';
import {
  DepartmentCoverageStatus,
  ShiftBriefingActionItem,
  ShiftBriefingActionPriority,
  ShiftBriefingDepartment,
  ShiftBriefingResponse,
  ShiftBriefingWorker,
  ShiftTrustBriefRisk,
  ShiftTrustBriefStatus,
  WorkerCoverageStatus,
} from '@/lib/types';

const coverageStyles: Record<DepartmentCoverageStatus, string> = {
  covered: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/20',
  short: 'bg-amber-400/10 text-amber-300 border-amber-400/20',
  critical: 'bg-red-400/10 text-red-300 border-red-400/20',
  unscheduled: 'bg-slate-400/10 text-slate-300 border-slate-400/20',
};

const workerStyles: Record<WorkerCoverageStatus, string> = {
  present: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/20',
  late: 'bg-amber-400/10 text-amber-300 border-amber-400/20',
  missing: 'bg-red-400/10 text-red-300 border-red-400/20',
  clocked_out: 'bg-slate-400/10 text-slate-300 border-slate-400/20',
  still_clocked_in: 'bg-blue-400/10 text-blue-300 border-blue-400/20',
};

const priorityStyles: Record<ShiftBriefingActionPriority, string> = {
  critical: 'bg-red-400/10 text-red-300 border-red-400/20',
  warning: 'bg-amber-400/10 text-amber-300 border-amber-400/20',
  info: 'bg-blue-400/10 text-blue-300 border-blue-400/20',
};

const readinessStyles: Record<ShiftTrustBriefStatus, string> = {
  ready: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/20',
  attention: 'bg-amber-400/10 text-amber-300 border-amber-400/20',
  blocked: 'bg-red-400/10 text-red-300 border-red-400/20',
};

type PortalRole = 'admin' | 'enrollment' | 'viewer' | string;

function titleCase(value: string) {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatTime(value: string | null) {
  if (!value) return 'No scan';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatGeneratedAt(value?: string) {
  if (!value) return 'Not generated';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function escapeCsv(value: unknown) {
  const text = String(value ?? '');
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function briefingCsv(
  date: string,
  workers: ShiftBriefingWorker[],
  actions: ShiftBriefingActionItem[],
  role: PortalRole | undefined,
) {
  const workerHeaders = [
    'Date',
    'Worker',
    'Department',
    'Schedule',
    'Scheduled Start',
    'Scheduled End',
    'Status',
    'First Seen',
    'Last Seen',
    'Event Count',
  ];
  const workerRows = workers.map((worker) => [
    date,
    worker.worker_name,
    worker.department,
    worker.schedule_name,
    worker.scheduled_start,
    worker.scheduled_end,
    worker.status,
    worker.first_seen || '',
    worker.last_seen || '',
    worker.event_count,
  ]);
  const actionHeaders = ['Date', 'Priority', 'Action', 'Description', 'Href'];
  const actionRows = actions.map((action) => [
    date,
    action.priority,
    action.label,
    action.description,
    canOperateBriefingAction(role, action.href) ? action.href : getReviewHref(action.href, date),
  ]);
  const sections = actionRows.length
    ? [workerHeaders, ...workerRows, [], ['Action Items'], actionHeaders, ...actionRows]
    : [workerHeaders, ...workerRows];
  return sections.map((row) => row.map(escapeCsv).join(',')).join('\n');
}

function departmentRisk(row: ShiftBriefingDepartment) {
  if (row.expected === 0) return 0;
  return Math.round(((row.missing + row.late) / row.expected) * 100);
}

function validDateParam(value: string | null) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function validWorkerStatusParam(value: string | null): WorkerCoverageStatus | 'all' {
  return value === 'missing' || value === 'late' || value === 'present' || value === 'clocked_out' || value === 'still_clocked_in'
    ? value
    : 'all';
}

function stripHrefParams(href: string, keysToStrip: string[]) {
  const [path, query = ''] = href.split('?');
  if (!query) return href;
  const blocked = new Set(keysToStrip);
  const nextQuery = query
    .split('&')
    .filter((entry) => {
      const key = decodeURIComponent(entry.split('=')[0] || '');
      return !blocked.has(key);
    })
    .join('&');
  return nextQuery ? `${path}?${nextQuery}` : path;
}

function buildHref(path: string, params: Record<string, string | number | null | undefined>) {
  const query = Object.entries(params)
    .filter((entry): entry is [string, string | number] => entry[1] !== null && entry[1] !== undefined && entry[1] !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
  return query ? `${path}?${query}` : path;
}

function canOperateBriefingAction(role: PortalRole | undefined, href: string) {
  if (role === 'admin') return true;
  if (role !== 'enrollment') return false;
  return href.startsWith('/exceptions') || href.startsWith('/briefing') || href.startsWith('/enroll?worker_id=');
}

function getReviewHref(href: string, date: string) {
  if (href.startsWith('/exceptions')) return stripHrefParams(href, ['intent']);
  if (href === '/kiosks' || href === '/schedules' || href.startsWith('/enroll')) return `/briefing?date=${date}`;
  return href;
}

function getKioskTrustHref(role: PortalRole | undefined, date: string) {
  return role === 'admin' ? '/kiosks' : buildHref('/briefing', { date });
}

function hrefHasExactSource(href: string) {
  return href.includes('exception_key=') || href.includes('attempt_id=') || href.includes('worker_id=');
}

function getBriefingNextStep(
  payload: ShiftBriefingResponse | null,
  role: PortalRole | undefined,
  date: string,
) {
  const action = payload?.shift_trust_brief?.primary_action || payload?.action_items[0];
  if (!action || payload?.backend_unavailable) return null;
  const canOperateAction = canOperateBriefingAction(role, action.href);
  const href = canOperateAction ? action.href : getReviewHref(action.href, date);
  const exact = hrefHasExactSource(href);
  const actionCta = 'cta' in action && typeof action.cta === 'string' ? action.cta : 'Open action';
  const sourceLabel = 'source_label' in action && typeof action.source_label === 'string' ? action.source_label : 'Briefing evidence';
  const proofLabel = 'proof_label' in action && typeof action.proof_label === 'string'
    ? action.proof_label
    : exact
      ? 'Exact source'
      : 'Source view';

  return {
    label: `${canOperateAction ? 'Open first' : 'Review first'}: ${action.label}`,
    description: action.description,
    href,
    cta: canOperateAction ? actionCta : 'Review source',
    priority: action.priority,
    exact,
    reviewOnly: !canOperateAction,
    sourceLabel,
    proofLabel,
  };
}

function getRoleSafeRiskHref(risk: ShiftTrustBriefRisk, role: PortalRole | undefined, date: string) {
  return canOperateBriefingAction(role, risk.href) ? risk.href : getReviewHref(risk.href, date);
}

function ShiftBriefingPageContent() {
  const searchParams = useSearchParams();
  const queryDate = validDateParam(searchParams.get('date')) || getFactoryLocalDateString();
  const queryDepartment = searchParams.get('department') || 'all';
  const queryStatus = validWorkerStatusParam(searchParams.get('status'));
  const currentRole = usePortalRole();
  const [date, setDate] = useState(queryDate);
  const [payload, setPayload] = useState<ShiftBriefingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [department, setDepartment] = useState(queryDepartment);
  const [status, setStatus] = useState<WorkerCoverageStatus | 'all'>(queryStatus);

  useEffect(() => {
    setDate(queryDate);
    setDepartment(queryDepartment);
    setStatus(queryStatus);
  }, [queryDate, queryDepartment, queryStatus]);

  const fetchBriefing = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/shift-briefing?date=${date}`, { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || 'Failed to load shift briefing');
      setPayload(body);
    } catch (err) {
      setPayload(null);
      setError(err instanceof Error ? err.message : 'Failed to load shift briefing');
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    fetchBriefing();
  }, [fetchBriefing]);

  const departments = useMemo(() => {
    const values = payload?.departments.map((row) => row.department) || [];
    return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
  }, [payload]);

  const filteredDepartments = useMemo(() => {
    const rows = payload?.departments || [];
    return rows.filter((row) => department === 'all' || row.department === department);
  }, [department, payload]);

  const filteredWorkers = useMemo(() => {
    const rows = payload?.workers || [];
    return rows.filter((worker) => {
      const departmentMatches = department === 'all' || worker.department === department;
      const statusMatches = status === 'all' || worker.status === status;
      return departmentMatches && statusMatches;
    });
  }, [department, payload, status]);
  const reviewLinks = useMemo(() => {
    const departmentFilter = department === 'all' ? undefined : department;
    return [
      {
        label: 'Exceptions',
        href: buildHref('/exceptions', { date, status: 'open', department: departmentFilter }),
      },
      { label: 'Activity Log', href: buildHref('/log', { date }) },
      { label: 'Workers', href: '/workers' },
      { label: 'Schedules', href: '/schedules' },
      {
        label: 'Recognition Lab',
        href: buildHref('/calibration/recognition', { date, review_status: 'unreviewed' }),
      },
      { label: 'Kiosks', href: getKioskTrustHref(currentRole, date) },
    ];
  }, [currentRole, date, department]);

  function exportCsv() {
    const csv = briefingCsv(date, filteredWorkers, payload?.action_items || [], currentRole);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gatekeeper-shift-briefing-${date}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const summary = payload?.summary;
  const trustBrief = payload?.shift_trust_brief;
  const sourceCounts = trustBrief?.source_counts;
  const riskLabel = !payload
    ? 'Loading briefing'
    : summary?.expected === 0
      ? 'No scheduled coverage'
      : summary?.critical_actions
        ? 'Coverage needs action'
        : summary?.late || summary?.missing || summary?.kiosk_warnings
          ? 'Review before shift'
          : 'Coverage on track';
  const nextStep = getBriefingNextStep(payload, currentRole, date);
  const hasExportableBriefing = filteredWorkers.length > 0 || Boolean(payload?.action_items.length);
  const readinessLabel = trustBrief ? titleCase(trustBrief.readiness_status) : riskLabel;
  const readinessTone = trustBrief ? readinessStyles[trustBrief.readiness_status] : 'bg-slate-400/10 text-slate-300 border-slate-400/20';

  return (
    <div className="animate-fade-in space-y-6 pb-24 md:pb-8">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <p className="section-label mb-2">Supervisor briefing</p>
          <h1 className="page-title text-slate-100">
            Shift <span className="text-gold">Coverage</span>
          </h1>
          <p className="text-sm text-slate-400 mt-2 max-w-2xl leading-6">
            Daily coverage risk, staffing gaps, kiosk trust signals, and the first actions to review.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button type="button" onClick={fetchBriefing} className="btn-secondary" disabled={loading}>
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
          <button type="button" onClick={() => window.print()} className="btn-secondary">
            Print
          </button>
          <button type="button" onClick={exportCsv} className="btn-primary" disabled={!hasExportableBriefing}>
            Export CSV
          </button>
        </div>
      </div>

      <section className="glass-card p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <p className="section-label mb-2">Morning Readiness Brief</p>
            <h2 className="font-display text-2xl text-slate-100">{readinessLabel}</h2>
            <p className="text-sm text-slate-400 mt-2 max-w-3xl leading-6">
              {trustBrief?.summary_sentence || `${riskLabel}. Generated ${formatGeneratedAt(payload?.generated_at)} for ${date}.`}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <span className="badge border border-navy-500/60 bg-navy-950/35 text-[10px] text-slate-400">
                {trustBrief?.freshness.label || 'Generated from briefing evidence'}
              </span>
              <span className="badge border border-navy-500/60 bg-navy-950/35 text-[10px] text-slate-400">
                Generated {formatGeneratedAt(trustBrief?.generated_at || payload?.generated_at)}
              </span>
              <span className="badge border border-navy-500/60 bg-navy-950/35 text-[10px] text-slate-400">
                {payload?.schedules.active_today ?? 0} active schedule{payload?.schedules.active_today === 1 ? '' : 's'}
              </span>
            </div>
          </div>
          <span className={`badge border ${readinessTone}`}>
            {readinessLabel}
          </span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5 mt-5">
          {[
            ['Expected', sourceCounts?.expected ?? summary?.expected ?? 0, 'text-slate-100'],
            ['Present', sourceCounts?.present ?? summary?.present ?? 0, 'text-emerald-300'],
            ['Late', sourceCounts?.late ?? summary?.late ?? 0, 'text-amber-300'],
            ['Missing', sourceCounts?.missing ?? summary?.missing ?? 0, 'text-red-300'],
            ['Open Exceptions', sourceCounts?.open_exceptions ?? summary?.open_exceptions ?? 0, 'text-gold'],
            ['Critical Exceptions', sourceCounts?.critical_exceptions ?? 0, 'text-red-300'],
            ['Recognition Reviews', sourceCounts?.recognition_reviews ?? summary?.recognition_reviews ?? 0, 'text-blue-300'],
            ['Missing Clock-Outs', sourceCounts?.missing_clock_outs ?? 0, 'text-amber-300'],
            ['Corrections', sourceCounts?.corrections ?? 0, 'text-slate-200'],
            ['Kiosk Warnings', sourceCounts?.kiosk_warnings ?? summary?.kiosk_warnings ?? 0, 'text-blue-300'],
          ].map(([label, value, tone]) => (
            <div key={label} className="rounded-xl border border-navy-600/50 bg-navy-900/35 p-4">
              <p className="text-xs text-slate-500">{label}</p>
              <p className={`mt-1 font-display text-2xl ${tone}`}>{value}</p>
            </div>
          ))}
        </div>
        {nextStep && (
          <div className="mt-5 border-l-4 border-gold/70 bg-navy-950/25 px-4 py-3">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <p className="section-label text-gold">Primary action</p>
                <h3 className="mt-1 font-display text-base font-semibold text-slate-100">{nextStep.label}</h3>
                <p className="mt-1 text-sm leading-5 text-slate-400">{nextStep.description}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <span className={`badge border ${priorityStyles[nextStep.priority]}`}>{titleCase(nextStep.priority)}</span>
                  <span className="badge border border-navy-500/60 bg-navy-950/35 text-[10px] text-slate-400">{nextStep.sourceLabel}</span>
                  <span className="badge border border-gold/20 bg-gold/10 text-[10px] text-gold">{nextStep.proofLabel}</span>
                  {nextStep.exact && (
                    <span className="badge border border-gold/20 bg-gold/10 text-[10px] text-gold">Exact source</span>
                  )}
                  {nextStep.reviewOnly && (
                    <span className="badge border border-slate-400/15 bg-slate-400/5 text-[10px] text-slate-300">Review-only</span>
                  )}
                </div>
              </div>
              <Link href={nextStep.href} className="btn-primary shrink-0 self-start text-xs md:self-auto">
                {nextStep.cta}
              </Link>
            </div>
          </div>
        )}
        {trustBrief ? (
          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <div>
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-display text-sm font-semibold text-slate-100">Readiness blockers</h3>
                <span className="text-xs font-mono text-slate-500">{trustBrief?.readiness_blockers.length ?? 0}</span>
              </div>
              <div className="mt-3 space-y-2">
                {trustBrief?.readiness_blockers.length ? trustBrief.readiness_blockers.map((blocker) => (
                  <Link key={blocker.id} href={getRoleSafeRiskHref(blocker, currentRole, date)} className="block rounded-xl border border-navy-600/50 bg-navy-900/35 p-3 hover:border-gold/25 transition-colors">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-display text-sm font-medium text-slate-100">{blocker.label}</p>
                        <p className="mt-1 text-xs leading-5 text-slate-400">{blocker.description}</p>
                      </div>
                      <span className={`badge border text-[10px] ${priorityStyles[blocker.severity]}`}>{blocker.count}</span>
                    </div>
                  </Link>
                )) : (
                  <div className="rounded-xl border border-emerald-400/15 bg-emerald-400/5 p-3 text-sm text-emerald-200">
                    No readiness blockers from schedules, kiosk trust, enrollment, attendance, or critical exceptions.
                  </div>
                )}
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-display text-sm font-semibold text-slate-100">Closeout risks</h3>
                <span className="text-xs font-mono text-slate-500">{trustBrief?.closeout_risks.length ?? 0}</span>
              </div>
              <div className="mt-3 space-y-2">
                {trustBrief?.closeout_risks.length ? trustBrief.closeout_risks.map((risk) => (
                  <Link key={risk.id} href={getRoleSafeRiskHref(risk, currentRole, date)} className="block rounded-xl border border-navy-600/50 bg-navy-900/35 p-3 hover:border-gold/25 transition-colors">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-display text-sm font-medium text-slate-100">{risk.label}</p>
                        <p className="mt-1 text-xs leading-5 text-slate-400">{risk.description}</p>
                      </div>
                      <span className={`badge border text-[10px] ${priorityStyles[risk.severity]}`}>{risk.count}</span>
                    </div>
                  </Link>
                )) : (
                  <div className="rounded-xl border border-emerald-400/15 bg-emerald-400/5 p-3 text-sm text-emerald-200">
                    No closeout risks from missing clock-outs, recognition reviews, kiosk warnings, open exceptions, or corrections.
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : null}
        {trustBrief?.source_labels.length ? (
          <div className="mt-5 flex flex-wrap gap-2" aria-label="Morning readiness sources">
            {trustBrief.source_labels.map((label) => (
              <span key={label} className="rounded border border-navy-500/60 bg-navy-950/35 px-2 py-1 text-[10px] font-mono text-slate-400">
                {label}
              </span>
            ))}
          </div>
        ) : null}
      </section>

      {payload?.warning && (
        <div className="rounded-xl border border-amber-400/20 bg-amber-400/5 px-4 py-3 text-sm text-amber-200">
          {payload.warning}
        </div>
      )}

      {error && (
        <div role="alert" className="rounded-xl border border-red-400/20 bg-red-400/5 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <section className="glass-card p-5">
        <div className="grid gap-3 md:grid-cols-3">
          <label className="space-y-1.5">
            <span className="section-label block">Date</span>
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} className="input-field" />
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
            <span className="section-label block">Worker Status</span>
            <select value={status} onChange={(event) => setStatus(event.target.value as WorkerCoverageStatus | 'all')} className="input-field">
              <option value="all">All statuses</option>
              <option value="missing">Missing</option>
              <option value="late">Late</option>
              <option value="present">Present</option>
              <option value="clocked_out">Clocked out</option>
            </select>
          </label>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.9fr)]">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-display font-semibold text-slate-100">Coverage by department</h2>
            <span className="text-xs font-mono text-slate-500">{filteredDepartments.length} groups</span>
          </div>
          {loading && !payload ? (
            <div className="glass-card p-6 text-sm text-slate-400">Loading coverage briefing...</div>
          ) : filteredDepartments.length ? (
            filteredDepartments.map((row) => (
              <article key={`${row.department}-${row.schedule_name}-${row.scheduled_start}`} className="glass-card-hover p-5 space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-display font-semibold text-slate-100">{row.department}</h3>
                    <p className="text-xs font-mono text-slate-500 mt-1">
                      {row.schedule_name} · {row.scheduled_start}-{row.scheduled_end}
                    </p>
                  </div>
                  <span className={`badge border ${coverageStyles[row.status]}`}>{titleCase(row.status)}</span>
                </div>
                <div className="grid grid-cols-4 gap-2 text-center">
                  {[
                    ['Present', row.present, 'text-emerald-300'],
                    ['Expected', row.expected, 'text-slate-200'],
                    ['Late', row.late, 'text-amber-300'],
                    ['Missing', row.missing, 'text-red-300'],
                  ].map(([label, value, tone]) => (
                    <div key={label} className="rounded-xl bg-navy-900/40 border border-navy-600/40 p-3">
                      <p className={`font-display text-xl ${tone}`}>{value}</p>
                      <p className="text-[10px] uppercase tracking-wide text-slate-500 mt-1">{label}</p>
                    </div>
                  ))}
                </div>
                <div className="h-2 rounded-full bg-navy-900/70 overflow-hidden">
                  <div
                    className={`h-full ${departmentRisk(row) >= 50 ? 'bg-red-400' : departmentRisk(row) > 0 ? 'bg-amber-400' : 'bg-emerald-400'}`}
                    style={{ width: `${Math.min(100, Math.max(0, 100 - departmentRisk(row)))}%` }}
                  />
                </div>
              </article>
            ))
          ) : (
            <div className="glass-card p-6 text-sm text-slate-400 leading-6">
              No scheduled coverage in this view. Check the date or create an active schedule for this day.
            </div>
          )}
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-display font-semibold text-slate-100">First actions</h2>
            <span className="text-xs font-mono text-slate-500">{payload?.action_items.length ?? 0} items</span>
          </div>
          {payload?.action_items.length ? (
            <div className="space-y-3">
              {payload.action_items.slice(0, 10).map((item) => {
                const canOperateAction = canOperateBriefingAction(currentRole, item.href);
                return (
                  <Link
                    key={item.id}
                    href={canOperateAction ? item.href : getReviewHref(item.href, date)}
                    className="glass-card-hover p-4 block"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="font-display font-medium text-slate-100">{item.label}</h3>
                        <p className="text-sm text-slate-400 mt-1 leading-6">{item.description}</p>
                      </div>
                      <span className={`badge border ${priorityStyles[item.priority]}`}>{titleCase(item.priority)}</span>
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-3">
                      {!canOperateAction && (
                        <span className="rounded-full border border-slate-500/25 bg-slate-400/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-300">
                          Review-only
                        </span>
                      )}
                      <span className="ml-auto text-xs font-semibold text-gold">
                        {canOperateAction ? 'Open action' : 'Review source'}
                      </span>
                    </div>
                  </Link>
                );
              })}
            </div>
          ) : (
            <div className="glass-card p-6 text-sm text-slate-400 leading-6">
              No action items. Coverage, exceptions, and kiosk trust signals are clear for this view.
            </div>
          )}
        </div>
      </section>

      <section className="glass-card overflow-hidden">
        <div className="px-5 py-4 border-b border-navy-600/50 flex items-center justify-between gap-3">
          <h2 className="font-display font-semibold text-slate-100">Scheduled workers</h2>
          <span className="text-xs font-mono text-slate-500">{filteredWorkers.length} workers</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-navy-600/50">
                <th className="text-left py-3.5 px-5 section-label">Worker</th>
                <th className="text-left py-3.5 px-5 section-label">Department</th>
                <th className="text-left py-3.5 px-5 section-label">Schedule</th>
                <th className="text-left py-3.5 px-5 section-label">First Seen</th>
                <th className="text-left py-3.5 px-5 section-label">Last Seen</th>
                <th className="text-left py-3.5 px-5 section-label">Status</th>
              </tr>
            </thead>
            <tbody>
              {filteredWorkers.map((worker) => (
                <tr key={worker.worker_id} className="border-b border-navy-700/30 table-row-hover transition-colors">
                  <td className="py-3 px-5 font-display font-medium text-slate-200">{worker.worker_name}</td>
                  <td className="py-3 px-5 text-xs font-mono text-slate-500">{worker.department}</td>
                  <td className="py-3 px-5 text-xs font-mono text-slate-400">{worker.schedule_name}</td>
                  <td className="py-3 px-5 text-xs font-mono text-slate-400 tabular-nums">{formatTime(worker.first_seen)}</td>
                  <td className="py-3 px-5 text-xs font-mono text-slate-400 tabular-nums">{formatTime(worker.last_seen)}</td>
                  <td className="py-3 px-5">
                    <span className={`badge text-[11px] border ${workerStyles[worker.status]}`}>{titleCase(worker.status)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filteredWorkers.length === 0 && (
            <div className="p-6 text-sm text-slate-400">No workers match the selected briefing filters.</div>
          )}
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="glass-card p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-display font-semibold text-slate-100">Kiosk trust</h2>
              <p className="text-sm text-slate-400 mt-2">
                {payload?.kiosks.total ?? 0} registered kiosk{payload?.kiosks.total === 1 ? '' : 's'} contribute to today&apos;s briefing confidence.
              </p>
            </div>
            <Link href={getKioskTrustHref(currentRole, date)} className="btn-ghost text-xs">
              {currentRole === 'admin' ? 'Open' : 'Review'}
            </Link>
          </div>
          <div className="grid grid-cols-2 gap-3 mt-5">
            {[
              ['Online', payload?.kiosks.counts.online ?? 0, 'text-emerald-300'],
              ['Stale', payload?.kiosks.counts.stale ?? 0, 'text-amber-300'],
              ['Offline', payload?.kiosks.counts.offline ?? 0, 'text-red-300'],
              ['Never Synced', payload?.kiosks.counts.never_synced ?? 0, 'text-slate-300'],
            ].map(([label, value, tone]) => (
              <div key={label} className="rounded-xl border border-navy-600/50 bg-navy-900/35 p-4">
                <p className="text-xs text-slate-500">{label}</p>
                <p className={`mt-1 font-display text-2xl ${tone}`}>{value}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="glass-card p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-display font-semibold text-slate-100">Review links</h2>
              <p className="text-sm text-slate-400 mt-2">Jump to source views when a briefing item needs follow-up.</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 mt-5">
            {reviewLinks.map(({ label, href }) => (
              <Link key={href} href={href} className="rounded-xl border border-navy-600/50 bg-navy-900/35 px-4 py-3 text-sm text-slate-300 hover:text-gold hover:border-gold/25 transition-all">
                {label}
              </Link>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

export default function ShiftBriefingPage() {
  return (
    <Suspense fallback={null}>
      <ShiftBriefingPageContent />
    </Suspense>
  );
}
