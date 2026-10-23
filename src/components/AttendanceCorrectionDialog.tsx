'use client';

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, RefObject } from 'react';
import { createAttendanceClock } from '@/lib/attendance-time';
import { acknowledgeCorrectionRequest, correctionRequestId } from '@/lib/correction-request';
import { createLocalIsoTimestamp, DEFAULT_FACTORY_TIME_ZONE } from '@/lib/date';
import {
  clearPendingDirectCorrection,
  DirectCorrectionRequest,
  duplicateWindowDates,
  findPossibleDuplicate,
  futureCorrectionError,
  PendingDirectCorrection,
  reasonError,
  REASON_MAX_LENGTH,
  WorkerOption,
  writePendingDirectCorrection,
} from '@/lib/direct-correction';
import type { AttendanceWithWorker } from '@/lib/types';

type Phase = 'editing' | 'saving' | 'uncertain';
type EventType = 'clock_in' | 'clock_out';

export type AttendanceCorrectionDialogProps = {
  date: string;
  mode: 'void' | 'add';
  // void mode: the raw kiosk row to remove from effective attendance.
  sourceEvent?: AttendanceWithWorker | null;
  // add mode: selectable workers; lockedWorkerId pins the selection.
  workerOptions?: WorkerOption[];
  lockedWorkerId?: string;
  effectiveEvents: AttendanceWithWorker[];
  // An earlier save whose outcome is unknown. The dialog reopens frozen on it.
  pending?: PendingDirectCorrection | null;
  // False when the page's loaded selection no longer matches this draft.
  ready: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
  // The page owns the pending lock: it is set before every POST and cleared
  // only for the request ID that settled.
  onPendingStart: (pending: PendingDirectCorrection) => void;
  onPendingSettled: (requestId: string) => void;
  onSaved: () => void;
  // A definitive rejection that arrives after the dialog was closed.
  onRejectedAfterClose?: (message: string) => void;
  onClose: () => void;
  now?: () => Date;
};

export function formatFactoryTime(event: { timestamp: string; timestamp_utc?: string | null }) {
  const instant = createAttendanceClock().instantMs(event);
  if (!Number.isFinite(instant)) return event.timestamp;
  return new Date(instant).toLocaleTimeString('en-US', {
    timeZone: DEFAULT_FACTORY_TIME_ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function eventLabel(eventType: string) {
  return eventType === 'clock_in' ? 'Clock in' : eventType === 'clock_out' ? 'Clock out' : eventType;
}

const focusableSelector = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function AttendanceCorrectionDialog({
  date,
  mode: requestedMode,
  sourceEvent,
  workerOptions = [],
  lockedWorkerId,
  effectiveEvents,
  pending,
  ready,
  returnFocusRef,
  onPendingStart,
  onPendingSettled,
  onSaved,
  onRejectedAfterClose,
  onClose,
  now = () => new Date(),
}: AttendanceCorrectionDialogProps) {
  const initialRequest = pending?.request;
  const mode = initialRequest ? (initialRequest.action === 'void_event' ? 'void' : 'add') : requestedMode;
  const [phase, setPhase] = useState<Phase>(pending ? 'uncertain' : 'editing');
  const [frozen, setFrozen] = useState<PendingDirectCorrection | null>(pending || null);
  const [workerId, setWorkerId] = useState(initialRequest?.worker_id || lockedWorkerId || (workerOptions.length === 1 ? workerOptions[0].id : ''));
  const [eventType, setEventType] = useState<EventType>(initialRequest?.action === 'add_clock_in' ? 'clock_in' : 'clock_out');
  const [time, setTime] = useState(initialRequest?.corrected_timestamp?.slice(11, 16) || '');
  const [reason, setReason] = useState(initialRequest?.reason || '');
  const [supervisorName, setSupervisorName] = useState(initialRequest?.supervisor_name || '');
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<AttendanceWithWorker | null>(null);
  // The last attempt was refused for authentication, before the server could
  // look up the earlier request: its outcome is still unknown.
  const [signInRequired, setSignInRequired] = useState(false);
  const submittingRef = useRef(false);
  // Set once the dialog closes, so a pending pre-save check never posts.
  const closedRef = useRef(false);
  const modalRef = useRef<HTMLElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const closeRef = useRef<() => void>(() => {});

  const editable = phase === 'editing';
  const source = frozen?.source || (sourceEvent ? {
    time: formatFactoryTime(sourceEvent),
    event_type: sourceEvent.event_type,
    kiosk: sourceEvent.kiosk_name || sourceEvent.kiosk_id || '—',
    attendance_id: sourceEvent.id,
  } : undefined);
  const sourceWorkerLabel = frozen?.worker_label || (sourceEvent ? `${sourceEvent.worker_name || sourceEvent.worker_id}${sourceEvent.worker_department ? ` · ${sourceEvent.worker_department}` : ''}` : '');
  const selectableWorkers = lockedWorkerId ? workerOptions.filter((worker) => worker.id === lockedWorkerId) : workerOptions;

  useEffect(() => { closeRef.current = close; });

  // Browsers drop focus to <body> when the focused button becomes disabled,
  // and focus can leave the dialog in other ways. While the dialog is open,
  // keep Tab and Escape working from outside it and pull focus back in.
  // Declared before the focus-return effect so it is removed first.
  useEffect(() => {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
    const outside = (target: EventTarget | null) => !(target instanceof Node) || !overlayRef.current?.contains(target);
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (closedRef.current || !outside(event.target)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
      } else if (event.key === 'Tab') {
        event.preventDefault();
        const focusables = dialogFocusables();
        const target = event.shiftKey ? focusables[focusables.length - 1] : focusables[0];
        (target || headingRef.current)?.focus();
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      if (closedRef.current || !outside(event.target)) return;
      (dialogFocusables()[0] || headingRef.current)?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, []);

  useEffect(() => {
    // React Strict Mode runs this cleanup once on mount; reopen the flag.
    closedRef.current = false;
    const trigger = returnFocusRef?.current || (typeof document !== 'undefined' ? document.activeElement as HTMLElement | null : null);
    modalRef.current?.querySelector<HTMLElement>(focusableSelector)?.focus();
    return () => {
      closedRef.current = true;
      trigger?.focus?.();
    };
  // Capture the trigger once when the dialog opens.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Closing is always allowed. A request already sent stays persisted and
  // locked by the page, so reopening shows it frozen for an identical retry.
  function close() {
    closedRef.current = true;
    onClose();
  }

  function dialogFocusables() {
    return modalRef.current ? Array.from(modalRef.current.querySelectorAll<HTMLElement>(focusableSelector)) : [];
  }

  // Move focus to the dialog heading before a save disables the focused
  // button, so focus never falls out of the modal.
  function holdFocus() {
    headingRef.current?.focus?.();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab' || !modalRef.current) return;
    const focusables = dialogFocusables();
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    // Focus on a non-tabbable dialog element (the heading) wraps like the ends.
    const index = focusables.indexOf(active as HTMLElement);
    if (event.shiftKey && index <= 0) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (index === -1 || active === last)) {
      event.preventDefault();
      first.focus();
    }
  }

  function edited(update: () => void) {
    if (!editable) return;
    update();
    setDuplicate(null);
    setError(null);
  }

  async function send(record: PendingDirectCorrection) {
    holdFocus();
    submittingRef.current = true;
    setPhase('saving');
    setError(null);
    setSignInRequired(false);
    // Persist and lock before sending: if this dialog or page goes away
    // mid-request, the outcome is unknown and only the same request may be
    // retried, so no other direct draft can start meanwhile.
    writePendingDirectCorrection(record);
    onPendingStart(record);
    try {
      const response = await fetch('/api/attendance-corrections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...record.request, request_id: record.request_id }),
      });
      if (response.ok) {
        acknowledgeCorrectionRequest(record.request);
        clearPendingDirectCorrection(record.request_id);
        onPendingSettled(record.request_id);
        onSaved();
        return;
      }
      const body = await response.json().catch(() => ({}));
      if (response.status === 401 || response.status === 403) {
        // The portal refuses the request before Convex can return the
        // idempotent receipt, so this proves nothing about an earlier
        // attempt. Keep the payload and request ID frozen for a retry
        // after the supervisor signs in again.
        setFrozen(record);
        setPhase('uncertain');
        setSignInRequired(true);
        return;
      }
      if (response.status >= 400 && response.status < 500) {
        // A definitive rejection: nothing was saved, so the ID is released
        // and the supervisor may edit the draft.
        acknowledgeCorrectionRequest(record.request);
        clearPendingDirectCorrection(record.request_id);
        onPendingSettled(record.request_id);
        setFrozen(null);
        // A reopened save may belong to a worker outside the current filter;
        // rebind the editable draft to a worker this view can select.
        if (record.request.action !== 'void_event' && !selectableWorkers.some((worker) => worker.id === record.request.worker_id)) {
          setWorkerId(lockedWorkerId || '');
        }
        setPhase('editing');
        const message = typeof body?.error === 'string' && body.error ? body.error : 'The correction was not saved.';
        if (closedRef.current) onRejectedAfterClose?.(message);
        setError(message);
        return;
      }
      throw new Error('server');
    } catch {
      setFrozen(record);
      setPhase('uncertain');
    } finally {
      submittingRef.current = false;
    }
  }

  async function submit(confirmedDuplicate = false) {
    if (submittingRef.current || !ready) return;
    if (phase === 'uncertain') {
      if (frozen) await send(frozen);
      return;
    }
    if (phase !== 'editing') return;

    const reasonProblem = reasonError(reason);
    if (reasonProblem) { setError(reasonProblem); return; }

    let request: DirectCorrectionRequest;
    let workerLabel: string;
    if (mode === 'void') {
      if (!sourceEvent) { setError('The selected attendance row is no longer loaded. Close and choose it again.'); return; }
      const futureProblem = futureCorrectionError(date, null, now());
      if (futureProblem) { setError(futureProblem); return; }
      request = {
        date,
        worker_id: sourceEvent.worker_id,
        action: 'void_event',
        original_attendance_id: sourceEvent.id,
        reason: reason.trim(),
        supervisor_name: supervisorName.trim() || undefined,
      };
      workerLabel = sourceWorkerLabel;
    } else {
      const worker = selectableWorkers.find((option) => option.id === workerId);
      if (!worker) { setError('Choose a worker.'); return; }
      let correctedTimestamp: string;
      try {
        correctedTimestamp = createLocalIsoTimestamp(date, time);
      } catch {
        setError('Enter the time as HH:mm.');
        return;
      }
      const futureProblem = futureCorrectionError(date, time, now());
      if (futureProblem) { setError(futureProblem); return; }
      if (!confirmedDuplicate) {
        let candidates = effectiveEvents;
        const adjacentDates = duplicateWindowDates(date, time);
        if (adjacentDates.length) {
          // Near midnight the duplicate window reaches the neighboring day.
          holdFocus();
          submittingRef.current = true;
          setPhase('saving');
          try {
            for (const adjacentDate of adjacentDates) {
              const params = new URLSearchParams({ date: adjacentDate, worker_id: worker.id });
              const response = await fetch(`/api/attendance?${params.toString()}`);
              const rows = response.ok ? await response.json() : null;
              if (!Array.isArray(rows)) throw new Error('adjacent day unavailable');
              candidates = [...candidates, ...rows];
            }
          } catch {
            if (!closedRef.current) {
              setPhase('editing');
              setError('Could not check the neighboring day for a possible duplicate. Try again.');
            }
            return;
          } finally {
            submittingRef.current = false;
          }
          if (closedRef.current) return;
          setPhase('editing');
        }
        const match = findPossibleDuplicate(candidates, worker.id, eventType, correctedTimestamp);
        if (match) {
          setDuplicate(match);
          return;
        }
      }
      request = {
        date,
        worker_id: worker.id,
        action: eventType === 'clock_in' ? 'add_clock_in' : 'add_clock_out',
        corrected_timestamp: correctedTimestamp,
        reason: reason.trim(),
        supervisor_name: supervisorName.trim() || undefined,
      };
      workerLabel = `${worker.name}${worker.department ? ` · ${worker.department}` : ''}`;
    }

    setDuplicate(null);
    await send({ request, request_id: correctionRequestId(request), worker_label: workerLabel, source: mode === 'void' ? source : undefined });
  }

  const title = mode === 'void' ? 'Correct attendance row' : 'Add missing punch';

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 px-4 py-6 backdrop-blur-sm md:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="direct-correction-title"
      ref={overlayRef}
      onKeyDown={handleKeyDown}
    >
      <section ref={modalRef} className="w-full max-w-2xl rounded-2xl border border-navy-600/70 bg-navy-950 p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="section-label mb-2">Direct correction · {date}</p>
            <h2 id="direct-correction-title" ref={headingRef} tabIndex={-1} className="font-display text-2xl text-slate-100 focus:outline-none">{title}</h2>
            <p className="mt-2 text-sm leading-6 text-slate-400">
              Audited and reversible. The original kiosk evidence stays in the record.
            </p>
          </div>
          <button type="button" className="btn-ghost text-xs" onClick={close}>
            Close
          </button>
        </div>

        {mode === 'void' ? (
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <label className="space-y-1.5">
              <span className="section-label block">Worker</span>
              <input value={sourceWorkerLabel || 'Unknown worker'} readOnly className="input-field" />
            </label>
            <label className="space-y-1.5">
              <span className="section-label block">Event</span>
              <input value={source ? eventLabel(source.event_type) : ''} readOnly className="input-field" />
            </label>
            <label className="space-y-1.5">
              <span className="section-label block">Time (factory)</span>
              <input value={source?.time || ''} readOnly className="input-field font-mono" />
            </label>
            <label className="space-y-1.5">
              <span className="section-label block">Kiosk</span>
              <input value={source?.kiosk || ''} readOnly className="input-field" />
            </label>
            <div className="rounded-xl border border-amber-400/20 bg-amber-400/5 p-4 text-sm text-amber-100/85 md:col-span-2">
              This voids raw event <span className="font-mono text-amber-100">{source?.attendance_id}</span> from effective attendance. The kiosk row stays in the audit trail, and the void can be reversed from Correction history. To move a scan to another worker, void it here and then add the missing punch for the right worker.
            </div>
          </div>
        ) : (
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <label className="space-y-1.5">
              <span className="section-label block">Worker</span>
              {frozen ? (
                // The frozen request's worker, shown independently of the
                // current worker filter and option list.
                <input value={frozen.worker_label} readOnly className="input-field" />
              ) : (
              <select
                value={workerId}
                onChange={(event) => edited(() => setWorkerId(event.target.value))}
                disabled={!editable || Boolean(lockedWorkerId)}
                className="input-field"
              >
                {!lockedWorkerId && <option value="">Choose a worker</option>}
                {selectableWorkers.map((worker) => (
                  <option key={worker.id} value={worker.id}>
                    {worker.name}{worker.department ? ` · ${worker.department}` : ''}{worker.active ? '' : ' (inactive)'}
                  </option>
                ))}
              </select>
              )}
            </label>
            <label className="space-y-1.5">
              <span className="section-label block">Punch</span>
              <select
                value={eventType}
                onChange={(event) => edited(() => setEventType(event.target.value === 'clock_in' ? 'clock_in' : 'clock_out'))}
                disabled={!editable}
                className="input-field"
              >
                <option value="clock_in">Clock in</option>
                <option value="clock_out">Clock out</option>
              </select>
            </label>
            <label className="space-y-1.5">
              <span className="section-label block">Date</span>
              <input value={date} readOnly className="input-field font-mono" />
            </label>
            <label className="space-y-1.5">
              <span className="section-label block">Time (HH:mm)</span>
              <input
                type="time"
                value={time}
                onChange={(event) => edited(() => setTime(event.target.value))}
                disabled={!editable}
                aria-describedby="direct-correction-time-help"
                className="input-field font-mono"
              />
            </label>
            <p id="direct-correction-time-help" className="text-xs leading-5 text-slate-500 md:col-span-2">
              Factory time (America/Chicago) on the loaded log date. When clocks fall back, a time in the repeated hour is saved as its earlier (daylight time) occurrence. Times in the hour skipped when clocks spring forward do not exist; do not enter them.
            </p>
          </div>
        )}

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="space-y-1.5 md:col-span-2">
            <span className="section-label block">Correction reason</span>
            <textarea
              rows={3}
              value={reason}
              maxLength={REASON_MAX_LENGTH}
              onChange={(event) => edited(() => setReason(event.target.value))}
              disabled={!editable}
              placeholder="Required: what evidence shows this record is wrong?"
              className="input-field resize-y"
            />
          </label>
          <label className="space-y-1.5">
            <span className="section-label block">Supervisor name</span>
            <input
              value={supervisorName}
              maxLength={200}
              onChange={(event) => edited(() => setSupervisorName(event.target.value))}
              disabled={!editable}
              placeholder="Optional"
              className="input-field"
            />
          </label>
        </div>

        {phase === 'uncertain' && (
          <div role="alert" className="mt-4 rounded-xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm text-amber-100">
            <p className="font-medium">{signInRequired ? 'Sign in again to finish this save' : 'Save may have completed'}</p>
            <p className="mt-1 text-amber-100/80">
              {signInRequired ? (
                <>Your session was not accepted, so the server could not confirm this correction. Sign in again in a new tab (<a href="/login" target="_blank" rel="noopener" className="text-gold underline">open sign-in</a>), then use Retry same save. It resends the same request, so the correction is recorded at most once. Editing stays locked until the outcome is known.</>
              ) : (
                <>The server did not confirm this correction. Retry the same save to get its receipt; a repeated request is recorded only once. Editing is locked until the outcome is known.</>
              )}
            </p>
          </div>
        )}
        {error && (
          <div role="alert" className="mt-4 rounded-xl border border-red-400/20 bg-red-400/5 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}
        {duplicate && (
          <div role="alert" className="mt-4 rounded-xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm text-amber-100">
            <p className="font-medium">Possible duplicate</p>
            <p className="mt-1 text-amber-100/80">
              {duplicate.worker_name || duplicate.worker_id} already has an effective {eventLabel(duplicate.event_type).toLowerCase()} at {formatFactoryTime(duplicate)}{duplicate.timestamp.slice(0, 10) !== date ? ` on ${duplicate.timestamp.slice(0, 10)}` : ''}, within 2 minutes of this time. Save anyway only if both punches are real.
            </p>
          </div>
        )}

        <div className="mt-5 flex flex-wrap justify-end gap-3">
          <button type="button" className="btn-secondary" onClick={close}>
            {phase === 'uncertain' ? 'Close (keep pending)' : phase === 'saving' ? 'Close' : 'Cancel'}
          </button>
          {phase === 'uncertain' || (phase === 'saving' && frozen) ? (
            <button type="button" className="btn-primary" onClick={() => void submit()} disabled={phase === 'saving' || !ready}>
              {phase === 'saving' ? 'Retrying…' : 'Retry same save'}
            </button>
          ) : duplicate ? (
            <button type="button" className="btn-primary" onClick={() => void submit(true)} disabled={phase !== 'editing' || !ready}>
              Save anyway
            </button>
          ) : (
            <button type="button" className="btn-primary" onClick={() => void submit()} disabled={phase !== 'editing' || !ready || !reason.trim()}>
              {phase === 'saving' ? 'Saving…' : mode === 'void' ? 'Void row' : 'Add punch'}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
