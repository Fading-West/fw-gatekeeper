'use client';

import { Suspense, useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { useToast } from '@/components/Toast';
import {
  RecognitionAttempt,
  RecognitionAttemptsResponse,
  RecognitionConfidenceBand,
  RecognitionDecision,
  RecognitionReviewStatus,
} from '@/lib/types';
import { getFactoryLocalDateString } from '@/lib/date';
import { usePortalRole } from '@/hooks/usePortalRole';
import { useSelectedData } from '@/hooks/useSelectedData';

const decisionOptions: Array<{ value: RecognitionDecision | 'all'; label: string }> = [
  { value: 'all', label: 'All decisions' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'accepted_already_clocked', label: 'Already clocked' },
  { value: 'near_miss', label: 'Near miss' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'rejected_unknown', label: 'Rejected unknown' },
  { value: 'rejected_no_embedding', label: 'No embedding' },
  { value: 'rejected_model_error', label: 'Model error' },
  { value: 'unknown', label: 'Unknown' },
];

const reviewOptions: Array<{ value: RecognitionReviewStatus | 'all'; label: string }> = [
  { value: 'all', label: 'All reviews' },
  { value: 'unreviewed', label: 'Unreviewed' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'corrected', label: 'Corrected' },
  { value: 'ignored', label: 'Ignored' },
];

const confidenceOptions: Array<{ value: RecognitionConfidenceBand | 'all'; label: string }> = [
  { value: 'all', label: 'All confidence' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

const reviewStyles: Record<RecognitionReviewStatus, string> = {
  unreviewed: 'bg-slate-400/10 text-slate-300 border-slate-400/20',
  confirmed: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/20',
  corrected: 'bg-blue-400/10 text-blue-300 border-blue-400/20',
  ignored: 'bg-navy-700/70 text-slate-400 border-navy-600/50',
};

type PortalRole = 'admin' | 'enrollment' | 'viewer' | string;

function decisionStyle(decision: RecognitionDecision) {
  if (decision.startsWith('accepted')) return 'bg-emerald-400/10 text-emerald-300 border-emerald-400/20';
  if (decision === 'near_miss') return 'bg-gold/10 text-gold border-gold/20';
  if (decision.startsWith('rejected')) return 'bg-red-400/10 text-red-300 border-red-400/20';
  return 'bg-amber-400/10 text-amber-300 border-amber-400/20';
}

function formatScore(value: number | null | undefined) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—';
  return value.toFixed(3);
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || '—';
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function titleCase(value: string) {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function validDateParam(value: string | null) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function validDecisionParam(value: string | null): RecognitionDecision | 'all' {
  return decisionOptions.some((option) => option.value === value) ? value as RecognitionDecision | 'all' : 'all';
}

function validReviewParam(value: string | null): RecognitionReviewStatus | 'all' {
  return value === 'unreviewed' || value === 'confirmed' || value === 'corrected' || value === 'ignored' || value === 'all' ? value : 'all';
}

function validConfidenceParam(value: string | null): RecognitionConfidenceBand | 'all' {
  return value === 'high' || value === 'medium' || value === 'low' || value === 'all' ? value : 'all';
}

function canOperateRecognition(role: PortalRole | undefined) {
  return role === 'admin' || role === 'enrollment';
}

function recognitionAttemptRowId(id: string) {
  return `recognition-attempt-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function RecognitionCalibrationLabContent() {
  const { toast } = useToast();
  const searchParams = useSearchParams();
  const queryDate = validDateParam(searchParams.get('date')) || getFactoryLocalDateString();
  const queryDecision = validDecisionParam(searchParams.get('decision'));
  const queryReviewStatus = validReviewParam(searchParams.get('review_status'));
  const queryConfidenceBand = validConfidenceParam(searchParams.get('confidence_band'));
  const queryKioskId = searchParams.get('kiosk_id') || '';
  const queryAttemptId = searchParams.get('attempt_id') || '';
  const currentRole = usePortalRole();
  const [date, setDate] = useState(queryDate);
  const [decision, setDecision] = useState<RecognitionDecision | 'all'>(queryDecision);
  const [reviewStatus, setReviewStatus] = useState<RecognitionReviewStatus | 'all'>(queryReviewStatus);
  const [confidenceBand, setConfidenceBand] = useState<RecognitionConfidenceBand | 'all'>(queryConfidenceBand);
  const [kioskId, setKioskId] = useState(queryKioskId);
  const [isReviewPending, setIsReviewPending] = useState(false);
  const reviewPendingRef = useRef(false);

  useEffect(() => {
    setDate(queryDate);
    setDecision(queryDecision);
    setReviewStatus(queryReviewStatus);
    setConfidenceBand(queryConfidenceBand);
    setKioskId(queryKioskId);
  }, [queryConfidenceBand, queryDate, queryDecision, queryKioskId, queryReviewStatus]);

  const queryString = useMemo(() => {
    const params = new URLSearchParams({ date, limit: queryAttemptId ? '1000' : '150' });
    if (decision !== 'all') params.set('decision', decision);
    if (reviewStatus !== 'all') params.set('review_status', reviewStatus);
    if (confidenceBand !== 'all') params.set('confidence_band', confidenceBand);
    if (kioskId.trim()) params.set('kiosk_id', kioskId.trim());
    if (queryAttemptId) params.set('attempt_id', queryAttemptId);
    return params.toString();
  }, [confidenceBand, date, decision, kioskId, queryAttemptId, reviewStatus]);

  const currentQueryRef = useRef(queryString);
  currentQueryRef.current = queryString;
  const loadAttempts = useCallback(async (signal: AbortSignal): Promise<RecognitionAttemptsResponse> => {
    const res = await fetch(`/api/recognition-attempts?${queryString}`, { cache: 'no-store', signal });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error || 'Failed to load recognition attempts');
    if (!Array.isArray(body?.attempts) || !body.summary) throw new Error('Invalid recognition response. Refresh to try again.');
    return body;
  }, [queryString]);
  const { data: payload, loading, error, refresh: fetchAttempts } = useSelectedData(queryString, loadAttempts);
  const dataReady = Boolean(payload && !loading && !error);

  const attempts = useMemo(() => payload?.attempts ?? [], [payload]);
  const summary = payload?.summary;
  const canOperate = canOperateRecognition(currentRole);
  const kiosks = useMemo(() => {
    const ids = attempts.flatMap((attempt) => (attempt.kiosk_id ? [attempt.kiosk_id] : []));
    return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b));
  }, [attempts]);

  useEffect(() => {
    if (!queryAttemptId || !attempts.some((attempt) => attempt.id === queryAttemptId)) return;
    document.getElementById(recognitionAttemptRowId(queryAttemptId))?.scrollIntoView({ block: 'center' });
  }, [attempts, queryAttemptId]);

  function reviewAttempt(attempt: RecognitionAttempt, nextStatus: RecognitionReviewStatus) {
    if (!dataReady || currentQueryRef.current !== queryString || reviewPendingRef.current || !attempts.some((row) => row.id === attempt.id)) return;
    if (!canOperate) {
      toast('Only admin or enrollment roles can update recognition reviews.', 'error');
      return;
    }
    reviewPendingRef.current = true;
    setIsReviewPending(true);
    void (async () => {
      try {
        const res = await fetch('/api/recognition-attempts', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: attempt.id,
            review_status: nextStatus,
            decision: attempt.decision,
          }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error || 'Failed to update review');
        toast(`Attempt marked ${titleCase(nextStatus)}`);
        await fetchAttempts();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to update review', 'error');
      } finally {
        reviewPendingRef.current = false;
        setIsReviewPending(false);
      }
    })();
  }

  return (
    <div className="animate-fade-in space-y-6 pb-24 md:pb-8">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <p className="section-label mb-2">Calibration</p>
          <h1 className="page-title text-slate-100">
            Recognition <span className="text-gold">lab</span>
          </h1>
          <p className="text-sm text-slate-400 mt-2 max-w-2xl leading-6">
            Review kiosk recognition quality, tune confidence thresholds, and clear ambiguous scan attempts before they become attendance issues.
          </p>
        </div>
        <button type="button" onClick={fetchAttempts} className="btn-secondary" disabled={loading || isReviewPending}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <section className="glass-card p-5">
        <div className="grid gap-3 md:grid-cols-5">
          <label className="space-y-1.5">
            <span className="section-label block">Date</span>
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} className="input-field" />
          </label>
          <label className="space-y-1.5">
            <span className="section-label block">Decision</span>
            <select value={decision} onChange={(event) => setDecision(event.target.value as RecognitionDecision | 'all')} className="input-field">
              {decisionOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1.5">
            <span className="section-label block">Review</span>
            <select value={reviewStatus} onChange={(event) => setReviewStatus(event.target.value as RecognitionReviewStatus | 'all')} className="input-field">
              {reviewOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1.5">
            <span className="section-label block">Confidence</span>
            <select value={confidenceBand} onChange={(event) => setConfidenceBand(event.target.value as RecognitionConfidenceBand | 'all')} className="input-field">
              {confidenceOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1.5">
            <span className="section-label block">Kiosk</span>
            <input
              list="recognition-kiosks"
              value={kioskId}
              onChange={(event) => setKioskId(event.target.value)}
              placeholder="Any kiosk"
              className="input-field"
            />
            <datalist id="recognition-kiosks">
              {kiosks.map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
          </label>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-7">
        {[
          ['Accepted', summary?.accepted ?? 0, 'text-emerald-300'],
          ['Rejected', summary?.rejected ?? 0, 'text-red-300'],
          ['Unknown', summary?.unknown ?? 0, 'text-amber-300'],
          ['Near miss', summary?.near_miss ?? 0, 'text-gold'],
          ['Low-margin accepted', summary?.low_margin_accepted ?? 0, 'text-gold'],
          ['Median score', formatScore(summary?.median_score), 'text-slate-100'],
          ['Review backlog', summary?.review_backlog ?? 0, 'text-blue-300'],
        ].map(([label, value, tone]) => (
          <div key={label} className="rounded-xl border border-navy-600/50 bg-navy-900/35 p-4">
            <p className="text-xs text-slate-500">{label}</p>
            <p className={`mt-1 font-display text-2xl ${tone}`}>{value}</p>
          </div>
        ))}
      </section>

      {error && (
        <div role="alert" className="rounded-xl border border-red-400/20 bg-red-400/5 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {payload?.backend_unavailable && (
        <div role="status" className="rounded-xl border border-amber-400/20 bg-amber-400/5 px-4 py-3 text-sm text-amber-200">
          {payload.warning || 'Recognition attempt storage is not available yet.'}
        </div>
      )}

      <section className="glass-card overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-navy-600/50 px-5 py-4">
          <div>
            <h2 className="font-display font-semibold text-slate-100">Recognition attempts</h2>
            <p className="text-xs font-mono text-slate-500">{summary?.total ?? attempts.length} attempts in current view</p>
          </div>
          {loading && <span className="text-xs text-slate-500">Loading…</span>}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1060px] text-left">
            <thead>
              <tr className="border-b border-navy-600/50 text-[11px] uppercase tracking-wider text-slate-500">
                <th className="px-4 py-3 font-medium">Time</th>
                <th className="px-4 py-3 font-medium">Candidate</th>
                <th className="px-4 py-3 font-medium">Decision</th>
                <th className="px-4 py-3 font-medium">Score</th>
                <th className="px-4 py-3 font-medium">Margin</th>
                <th className="px-4 py-3 font-medium">Liveness</th>
                <th className="px-4 py-3 font-medium">Kiosk</th>
                <th className="px-4 py-3 font-medium">Review</th>
                <th className="px-4 py-3 font-medium">Controls</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-navy-600/35">
              {attempts.map((attempt) => {
                const controlsDisabled = !dataReady || isReviewPending;
                const targeted = queryAttemptId === attempt.id;
                return (
                  <tr
                    id={recognitionAttemptRowId(attempt.id)}
                    key={attempt.id}
                    className={`text-sm text-slate-300 hover:bg-navy-800/35 ${targeted ? 'bg-gold/5 ring-1 ring-inset ring-gold/30' : ''}`}
                  >
                    <td className="px-4 py-3 text-xs text-slate-400">{formatDateTime(attempt.timestamp)}</td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-100">{attempt.candidate_worker_name || 'No candidate'}</p>
                      <p className="mt-0.5 text-xs font-mono text-slate-500">{attempt.candidate_worker_id || '—'}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`badge border ${decisionStyle(attempt.decision)}`}>{titleCase(attempt.decision)}</span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{formatScore(attempt.score)}</td>
                    <td className="px-4 py-3 font-mono text-xs">{formatScore(attempt.margin)}</td>
                    <td className="px-4 py-3">
                      <p className="font-mono text-xs">Threshold {formatScore(attempt.threshold)}</p>
                      <p className={attempt.liveness_passed ? 'text-xs text-emerald-300' : 'text-xs text-slate-500'}>
                        {attempt.liveness_passed === null || attempt.liveness_passed === undefined
                          ? 'Not reported'
                          : attempt.liveness_passed
                            ? 'Passed'
                            : 'Failed'}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-xs font-mono text-slate-400">{attempt.kiosk_name || attempt.kiosk_id || '—'}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`badge border ${reviewStyles[attempt.review_status]}`}>{titleCase(attempt.review_status)}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        {canOperate ? (
                          <>
                            <button
                              type="button"
                              onClick={() => reviewAttempt(attempt, 'confirmed')}
                              disabled={controlsDisabled}
                              className="rounded-lg border border-emerald-400/20 bg-emerald-400/5 px-2.5 py-1.5 text-xs font-medium text-emerald-300 transition-colors hover:bg-emerald-400/10 disabled:opacity-50"
                            >
                              Confirm
                            </button>
                            <button
                              type="button"
                              onClick={() => reviewAttempt(attempt, 'ignored')}
                              disabled={controlsDisabled}
                              className="rounded-lg border border-navy-600/60 bg-navy-800/60 px-2.5 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:border-slate-500 disabled:opacity-50"
                            >
                              Ignore
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            disabled
                            className="rounded-lg border border-navy-600/60 bg-navy-800/60 px-2.5 py-1.5 text-xs font-medium text-slate-300 disabled:opacity-70"
                          >
                            Review-only
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {!loading && !error && attempts.length === 0 && (
          <div className="px-5 py-12 text-center text-sm text-slate-500">
            No recognition attempts match these filters yet.
          </div>
        )}
      </section>
    </div>
  );
}

export default function RecognitionCalibrationLab() {
  return (
    <Suspense fallback={null}>
      <RecognitionCalibrationLabContent />
    </Suspense>
  );
}
