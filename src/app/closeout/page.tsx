'use client';

import { Suspense, useCallback, useEffect, useMemo, useState, useRef } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useToast } from '@/components/Toast';
import { getFactoryLocalDateString } from '@/lib/date';
import { usePortalRole } from '@/hooks/usePortalRole';
import { useSelectedData } from '@/hooks/useSelectedData';
import {
  ShiftCloseoutChecklistItem,
  ShiftCloseoutResponse,
  ShiftCloseoutStatus,
} from '@/lib/types';

const closeoutStyles: Record<ShiftCloseoutStatus, string> = {
  open: 'bg-amber-400/10 text-amber-300 border-amber-400/20',
  completed: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/20',
  reopened: 'bg-blue-400/10 text-blue-300 border-blue-400/20',
};

const checklistStyles: Record<string, string> = {
  clear: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/20',
  blocked: 'bg-red-400/10 text-red-300 border-red-400/20',
};

type PortalRole = 'admin' | 'enrollment' | 'viewer' | string;

function titleCase(value: string) {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function checklistExportLine(item: ShiftCloseoutChecklistItem) {
  const proof = item.proof
    ? ` Proof: ${item.proof.count} ${item.proof.label} (${item.proof.exact ? 'exact source' : 'source view'}: ${item.proof.href}).`
    : '';
  return `- ${item.label}: ${item.status} (${item.count}) - ${item.description}${proof}`;
}

function exportText(payload: ShiftCloseoutResponse, supervisorName: string, notes: string) {
  const summary = payload.closeout?.status === 'completed' ? payload.closeout.snapshot : payload.summary;
  const lines = [
    `FW Gatekeeper shift closeout - ${payload.date}`,
    `Status: ${payload.closeout?.status || 'open'}`,
    `Supervisor: ${supervisorName || payload.closeout?.supervisor_name || 'Not set'}`,
    `Completed: ${formatDateTime(payload.closeout?.completed_at)}`,
    '',
    payload.closeout?.status === 'completed' ? 'Signed summary' : 'Current summary',
    `Expected: ${summary.expected}`,
    `Present: ${summary.present}`,
    `Late: ${summary.late}`,
    `Missing: ${summary.missing}`,
    `Open exceptions: ${summary.open_exceptions}`,
    `Critical exceptions: ${summary.critical_exceptions}`,
    `Kiosk warnings: ${summary.kiosk_warnings}`,
    `Attendance corrections (current): ${payload.summary.attendance_corrections}`,
    '',
    'Current checklist',
    ...payload.checklist.map(checklistExportLine),
    '',
    'Current closeout draft',
    payload.closeout_draft?.narrative || 'No closeout draft available.',
    '',
    'Notes',
    notes || payload.closeout?.notes || 'No notes recorded.',
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `gatekeeper-shift-closeout-${payload.date}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

function checklistTone(item: ShiftCloseoutChecklistItem) {
  return checklistStyles[item.status] || checklistStyles.blocked;
}

function validDateParam(value: string | null) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function canOperateCloseout(role: PortalRole | undefined) {
  return role === 'admin' || role === 'enrollment';
}

function getCloseoutNextStep({
  payload,
  completed,
  acknowledgedBlockers,
  notes,
  sourceBlockerCount,
  canComplete,
  canOperate,
}: {
  payload: ShiftCloseoutResponse | null;
  completed: boolean;
  acknowledgedBlockers: boolean;
  notes: string;
  sourceBlockerCount: number;
  canComplete: boolean;
  canOperate: boolean;
}) {
  if (!payload || completed || payload.backend_unavailable) return null;

  if (sourceBlockerCount > 0 && acknowledgedBlockers && !notes.trim()) {
    return {
      label: canOperate ? 'Add acknowledgement note' : 'Acknowledgement note needed',
      description: 'Source blockers are acknowledged. Document the reason in closeout notes before completing the shift record.',
      href: null,
      cta: canOperate ? 'Add notes below' : 'Review notes below',
      exact: false,
      requiresAcknowledgement: true,
    };
  }

  const firstBlocker = payload.blockers[0];
  if (firstBlocker) {
    const proof = firstBlocker.proof;
    return {
      label: `Review first: ${firstBlocker.label}`,
      description: proof
        ? `${proof.count} ${proof.label} keep closeout blocked. ${proof.exact ? 'This opens the exact source row.' : 'Review the source evidence before acknowledgement.'}`
        : firstBlocker.description,
      href: proof?.href || firstBlocker.href,
      cta: proof?.exact ? 'Open exact source' : 'Open proof',
      exact: Boolean(proof?.exact),
      requiresAcknowledgement: sourceBlockerCount > 0,
    };
  }

  if (canComplete) {
    return {
      label: canOperate ? 'Ready for signoff' : 'Ready for supervisor signoff',
      description: canOperate
        ? 'Checklist evidence is clear. Complete closeout from the supervisor signoff controls when notes look right.'
        : 'Checklist evidence is clear. An admin or enrollment user can complete closeout from the supervisor signoff controls.',
      href: null,
      cta: canOperate ? 'Use signoff controls' : 'Review signoff',
      exact: false,
      requiresAcknowledgement: false,
    };
  }

  return null;
}

function ShiftCloseoutPageContent() {
  const { toast } = useToast();
  const searchParams = useSearchParams();
  const queryDate = validDateParam(searchParams.get('date')) || getFactoryLocalDateString();
  const currentRole = usePortalRole();
  const [date, setDate] = useState(queryDate);
  const [supervisorName, setSupervisorName] = useState('');
  const [notes, setNotes] = useState('');
  const [acknowledgedBlockers, setAcknowledgedBlockers] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const mutationPendingRef = useRef(false);
  const canOperate = canOperateCloseout(currentRole);

  useEffect(() => {
    setDate(queryDate);
  }, [queryDate]);

  const loadCloseout = useCallback(async (signal: AbortSignal): Promise<ShiftCloseoutResponse> => {
    const res = await fetch(`/api/shift-closeout?date=${date}`, { cache: 'no-store', signal });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error || 'Failed to load shift closeout');
    if (body.date !== date) throw new Error('The server returned a different shift date. Refresh to try again.');
    return body;
  }, [date]);
  const { data: payload, loading, error, refresh: fetchCloseout } = useSelectedData(date, loadCloseout);
  const dataReady = Boolean(payload && !loading && !error);

  useEffect(() => {
    setSupervisorName(payload?.closeout?.supervisor_name || '');
    setNotes(payload?.closeout?.notes || '');
    setAcknowledgedBlockers(Boolean(payload?.closeout?.acknowledged_blockers));
  }, [payload]);


  const status = payload?.closeout?.status || 'open';
  const completed = status === 'completed';
  const blockerCount = payload?.blockers.length || 0;
  const sourceBlockerCount = Number(payload?.summary.critical_exceptions || 0) +
    Number(payload?.summary.missing_clock_outs || 0) +
    Number(payload?.summary.recognition_reviews || 0) +
    Number(payload?.summary.kiosk_warnings || 0);
  const canComplete = Boolean(payload && (
    sourceBlockerCount > 0
      ? acknowledgedBlockers && notes.trim()
      : payload.can_complete
  ));
  const closeoutLabel = !dataReady ? (error ? 'Closeout unavailable' : 'Loading closeout') : completed ? 'Shift closeout complete' : blockerCount ? 'Closeout needs acknowledgement' : 'Ready to close shift';
  const closeoutDescription = !dataReady ? 'Wait for this shift record to load before signing off.' : completed
    ? `Completed ${formatDateTime(payload?.closeout?.completed_at)}. Reopen if a supervisor needs to correct the record.`
    : blockerCount
      ? 'Review the blocked checklist items or add an acknowledgement note before completing the closeout.'
      : 'Checklist is clear. Add supervisor notes and complete the daily record.';
  const nextStep = getCloseoutNextStep({
    payload,
    completed,
    acknowledgedBlockers,
    notes,
    sourceBlockerCount,
    canComplete,
    canOperate,
  });
  const suggestedNote = payload?.suggested_note || '';
  const closeoutDraft = payload?.closeout_draft || null;
  const draftNarrative = closeoutDraft?.narrative || '';
  const draftApplied = Boolean(draftNarrative) && notes.trim() === draftNarrative.trim();
  const suggestedNoteApplied = Boolean(suggestedNote) && notes.trim() === suggestedNote.trim();
  const showSuggestedNoteFallback = Boolean(suggestedNote && !draftNarrative && !completed && !payload?.backend_unavailable);

  const summaryRows = useMemo(() => {
    const summary = payload?.summary;
    return [
      ['Expected', summary?.expected ?? 0, 'text-slate-100'],
      ['Present', summary?.present ?? 0, 'text-emerald-300'],
      ['Late', summary?.late ?? 0, 'text-amber-300'],
      ['Missing', summary?.missing ?? 0, 'text-red-300'],
      ['Open Exceptions', summary?.open_exceptions ?? 0, 'text-gold'],
      ['Clock-out Blockers', summary?.missing_clock_outs ?? 0, 'text-amber-300'],
      ['Recognition Reviews', summary?.recognition_reviews ?? 0, 'text-blue-300'],
      ['Kiosk Warnings', summary?.kiosk_warnings ?? 0, 'text-blue-300'],
      ['Corrections', summary?.attendance_corrections ?? 0, 'text-gold'],
    ];
  }, [payload]);

  function updateCloseout(action: 'save' | 'complete' | 'reopen') {
    if (!dataReady || mutationPendingRef.current) return;
    if (!canOperate) {
      toast('Only admin or enrollment roles can update shift closeout.', 'error');
      return;
    }
    if (action === 'complete' && !canComplete) {
      toast('Add an acknowledgement note before completing with blockers.', 'error');
      return;
    }

    mutationPendingRef.current = true;
    setIsPending(true);
    void (async () => {
      try {
        const res = await fetch('/api/shift-closeout', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            date,
            action,
            supervisor_name: supervisorName,
            notes,
            acknowledged_blockers: acknowledgedBlockers,
          }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error || 'Failed to update closeout');
        toast(action === 'complete' ? 'Shift closeout completed' : action === 'reopen' ? 'Shift closeout reopened' : 'Closeout notes saved');
        await fetchCloseout();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to update closeout', 'error');
      } finally {
        mutationPendingRef.current = false;
        setIsPending(false);
      }
    })();
  }

  return (
    <div className="animate-fade-in space-y-6 pb-24 md:pb-8">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <p className="section-label mb-2">Supervisor record</p>
          <h1 className="page-title text-slate-100">
            Shift <span className="text-gold">Closeout</span>
          </h1>
          <p className="text-sm text-slate-400 mt-2 max-w-2xl leading-6">
            End-of-shift signoff for coverage, exceptions, kiosk trust signals, and supervisor notes.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button type="button" onClick={fetchCloseout} className="btn-secondary" disabled={loading || isPending}>
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
          <button type="button" onClick={() => dataReady && window.print()} disabled={!dataReady} className="btn-secondary">
            Print
          </button>
          <button type="button" onClick={() => payload && exportText(payload, supervisorName, notes)} className="btn-primary" disabled={!dataReady}>
            Export
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-xl border border-red-400/20 bg-red-400/5 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {payload?.backend_unavailable && (
        <div role="status" className="rounded-xl border border-amber-400/20 bg-amber-400/5 px-4 py-3 text-sm text-amber-200">
          {payload.warning || 'Shift closeout is waiting for deployment.'}
        </div>
      )}

      <section className="glass-card p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <p className="section-label mb-2">Closeout status</p>
            <h2 className="font-display text-2xl text-slate-100">{closeoutLabel}</h2>
            <p className="text-sm text-slate-400 mt-2 max-w-3xl leading-6">{closeoutDescription}</p>
          </div>
          <span className={`badge border ${closeoutStyles[status]}`}>{titleCase(status)}</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6 mt-5">
          {summaryRows.map(([label, value, tone]) => (
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
                <p className="section-label text-gold">Next closeout step</p>
                <h3 className="mt-1 font-display text-base font-semibold text-slate-100">{nextStep.label}</h3>
                <p className="mt-1 text-sm leading-5 text-slate-400">{nextStep.description}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {nextStep.exact && (
                    <span className="badge border border-gold/20 bg-gold/10 text-[10px] text-gold">Exact source</span>
                  )}
                  {nextStep.requiresAcknowledgement && (
                    <span className="badge border border-amber-400/15 bg-amber-400/5 text-[10px] text-amber-300">Acknowledgement required</span>
                  )}
                </div>
              </div>
              {nextStep.href ? (
                <Link href={nextStep.href} className="btn-primary shrink-0 self-start text-xs md:self-auto">
                  {nextStep.cta}
                </Link>
              ) : (
                <span className="btn-secondary pointer-events-none shrink-0 self-start text-xs opacity-70 md:self-auto">
                  {nextStep.cta}
                </span>
              )}
            </div>
          </div>
        )}
      </section>

      <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.8fr)]">
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-display font-semibold text-slate-100">Closeout checklist</h2>
            <span className="text-xs font-mono text-slate-500">{blockerCount} blockers</span>
          </div>
          {loading && !payload ? (
            <div className="glass-card p-6 text-sm text-slate-400">Loading closeout checklist...</div>
          ) : payload?.checklist.length ? (
            <div className="grid gap-3">
              {payload.checklist.map((item) => (
                <article key={item.id} className="glass-card-hover p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h3 className="font-display font-semibold text-slate-100">{item.label}</h3>
                      <p className="text-sm text-slate-400 mt-2 leading-6">{item.description}</p>
                      {item.proof && (
                        <Link
                          href={item.proof.href}
                          className="mt-3 inline-flex flex-wrap items-center gap-2 rounded border border-navy-600/50 bg-navy-950/35 px-3 py-2 text-xs text-slate-300 hover:border-gold/30 hover:text-gold"
                        >
                          <span className="font-mono text-slate-500">Proof</span>
                          <span>{item.proof.count} {item.proof.label}</span>
                          {item.proof.exact && (
                            <span className="rounded border border-gold/20 bg-gold/10 px-2 py-0.5 text-[10px] font-mono text-gold">
                              Exact source
                            </span>
                          )}
                        </Link>
                      )}
                      <Link href={item.href} className="mt-3 inline-flex text-xs font-semibold text-gold hover:text-gold-light">
                        Open source view →
                      </Link>
                    </div>
                    <span className={`badge border ${checklistTone(item)}`}>{titleCase(item.status)}</span>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="glass-card p-6 text-sm text-slate-400">No checklist is available for this date yet.</div>
          )}
        </div>

        <aside className="space-y-4">
          <section className="glass-card p-5 space-y-4">
            <div>
              <h2 className="font-display font-semibold text-slate-100">Supervisor signoff</h2>
              <p className="text-sm text-slate-400 mt-2">Save notes during the shift, then complete the record at close. Reopen a completed record before editing; its prior signoff stays in the audit history.</p>
            </div>
            <label className="space-y-1.5 block">
              <span className="section-label block">Date</span>
              <input type="date" disabled={isPending} value={date} onChange={(event) => setDate(event.target.value)} className="input-field" />
            </label>
            <label className="space-y-1.5 block">
              <span className="section-label block">Supervisor</span>
              <input
                value={supervisorName}
                onChange={(event) => {
                  if (!canOperate) return;
                  setSupervisorName(event.target.value);
                }}
                placeholder="Supervisor name"
                readOnly={completed || !dataReady || isPending || !canOperate}
                className="input-field"
              />
            </label>
            {closeoutDraft?.sections.length && !payload?.backend_unavailable ? (
              <div className="rounded-xl border border-gold/20 bg-gold/5 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="section-label text-gold">Closeout Autopilot</p>
                    <h3 className="mt-1 font-display text-base font-semibold text-slate-100">Draft narrative from today&apos;s evidence</h3>
                    <p className="mt-2 text-xs leading-5 text-slate-400">
                      Generated from deterministic source counts at {formatDateTime(closeoutDraft.generated_at)}.
                    </p>
                  </div>
                  {canOperate && !completed && (
                    <button
                      type="button"
                      className="btn-secondary shrink-0 text-xs"
                      onClick={() => setNotes(draftNarrative)}
                      disabled={isPending || draftApplied || !draftNarrative}
                    >
                      {draftApplied ? 'Draft applied' : 'Use draft'}
                    </button>
                  )}
                </div>
                <div className="mt-4 space-y-3">
                  {closeoutDraft.sections.map((section) => (
                    <div key={section.id} className="border-t border-navy-600/50 pt-3 first:border-t-0 first:pt-0">
                      <h4 className="text-sm font-semibold text-slate-100">{section.title}</h4>
                      <p className="mt-1 text-sm leading-6 text-slate-300">{section.paragraph}</p>
                      {section.source_links.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {section.source_links.map((link) => (
                            <Link
                              key={`${section.id}:${link.label}:${link.href}`}
                              href={link.href}
                              className="rounded border border-navy-600/60 bg-navy-950/35 px-2.5 py-1 text-[11px] text-slate-300 hover:border-gold/30 hover:text-gold"
                            >
                              {link.count ? `${link.count} ` : ''}{link.label}{link.exact ? ' - exact' : ''}
                            </Link>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                {sourceBlockerCount > 0 && (
                  <div className="mt-4 rounded-lg border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-xs leading-5 text-amber-200/90">
                    Using this draft only fills notes. It does not complete closeout or acknowledge blockers.
                  </div>
                )}
                {suggestedNote && (
                  <p className="mt-3 border-t border-navy-600/50 pt-3 text-xs leading-5 text-slate-500">
                    Simple summary: {suggestedNote}
                  </p>
                )}
              </div>
            ) : null}
            {showSuggestedNoteFallback && (
              <div className="rounded-xl border border-gold/20 bg-gold/5 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="section-label text-gold">Suggested note</p>
                    <p className="mt-2 text-sm leading-6 text-slate-300">{suggestedNote}</p>
                  </div>
                  {canOperate && (
                    <button
                      type="button"
                      className="btn-secondary shrink-0 text-xs"
                      onClick={() => setNotes(suggestedNote)}
                      disabled={isPending || suggestedNoteApplied}
                    >
                      {suggestedNoteApplied ? 'Applied' : 'Use note'}
                    </button>
                  )}
                </div>
                {sourceBlockerCount > 0 && (
                  <p className="mt-3 text-xs leading-5 text-amber-200/80">
                    Applying this note does not complete closeout. The blocker acknowledgement remains explicit.
                  </p>
                )}
              </div>
            )}
            <label className="space-y-1.5 block">
              <span className="section-label block">Closeout notes</span>
              <textarea
                rows={7}
                value={notes}
                onChange={(event) => {
                  if (!canOperate) return;
                  setNotes(event.target.value);
                }}
                placeholder={canOperate ? 'Document exceptions reviewed, kiosk caveats, or follow-up needed.' : 'Closeout notes'}
                readOnly={completed || !dataReady || isPending || !canOperate}
                className="input-field min-h-[180px] resize-y"
              />
            </label>
            {blockerCount > 0 && !completed && (
              <label className="flex items-start gap-3 rounded-xl border border-amber-400/20 bg-amber-400/5 p-3 text-sm text-amber-100">
                <input
                  type="checkbox"
                  checked={acknowledgedBlockers}
                  onChange={(event) => {
                    if (!canOperate) return;
                    setAcknowledgedBlockers(event.target.checked);
                  }}
                  disabled={!dataReady || isPending || !canOperate}
                  className="mt-1 h-4 w-4 rounded border-navy-500 bg-navy-900"
                />
                <span>I acknowledge the blocked closeout items and documented the reason in notes.</span>
              </label>
            )}
            <div className="flex flex-wrap gap-2">
              {canOperate ? (
                <>
                  <button type="button" className="btn-secondary" onClick={() => updateCloseout('save')} disabled={completed || !dataReady || isPending || !payload}>
                    Save notes
                  </button>
                  {completed ? (
                    <button type="button" className="btn-primary" onClick={() => updateCloseout('reopen')} disabled={!dataReady || isPending || !payload}>
                      Reopen
                    </button>
                  ) : (
                    <button type="button" className="btn-primary" onClick={() => updateCloseout('complete')} disabled={!dataReady || isPending || !payload || !canComplete}>
                      Complete closeout
                    </button>
                  )}
                </>
              ) : (
                <button type="button" className="btn-secondary" disabled>
                  Review-only
                </button>
              )}
            </div>
          </section>

          <section className="glass-card p-5">
            <h2 className="font-display font-semibold text-slate-100">Source views</h2>
            <div className="grid grid-cols-2 gap-3 mt-5">
              {(payload?.action_links.length ? payload.action_links : [
                { label: 'Briefing', href: `/briefing?date=${date}` },
                { label: 'Exceptions', href: `/exceptions?date=${date}` },
                { label: 'Kiosks', href: '/kiosks' },
                { label: 'Recognition Lab', href: `/calibration/recognition?date=${date}` },
              ]).map((link) => (
                <Link key={link.href} href={link.href} className="rounded-xl border border-navy-600/50 bg-navy-900/35 px-4 py-3 text-sm text-slate-300 hover:text-gold hover:border-gold/25 transition-all">
                  {link.label}
                </Link>
              ))}
            </div>
          </section>
        </aside>
      </section>
    </div>
  );
}

export default function ShiftCloseoutPage() {
  return (
    <Suspense fallback={null}>
      <ShiftCloseoutPageContent />
    </Suspense>
  );
}
