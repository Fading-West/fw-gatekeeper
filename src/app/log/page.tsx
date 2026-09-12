'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import AttendanceTable, { attendanceRowId } from '@/components/AttendanceTable';
import { useToast } from '@/components/Toast';
import { AttendanceCorrection, AttendanceCorrectionsResponse, AttendanceWithWorker } from '@/lib/types';
import { DEFAULT_FACTORY_TIME_ZONE, getFactoryLocalDateString } from '@/lib/date';

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
  const selectionKey = `${date}|${queryWorkerId}`;
  const exportsReady = !loading && !error && loadedSelection === selectionKey;
  const hasSourceContext = Boolean(queryWorkerId || queryAttendanceId);
  const fullDayHref = `/log?date=${encodeURIComponent(date)}`;

  useEffect(() => {
    setDate(queryDate);
  }, [queryDate]);

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
        setLoadedSelection(`${date}|${queryWorkerId}`);
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
  }, [date, queryWorkerId]);

  useEffect(() => {
    if (!queryAttendanceId || !events.some((event) => event.id === queryAttendanceId)) return;
    document.getElementById(attendanceRowId(queryAttendanceId))?.scrollIntoView({ block: 'center' });
  }, [events, queryAttendanceId]);

  // Kiosk timestamps are factory-local wall-clock strings without an offset.
  // Duration math must resolve them to real instants IN THE FACTORY TIMEZONE:
  // browser-local parsing would shift with the viewer's DST, and plain
  // wall-clock subtraction drops the extra/missing hour of a shift spanning a
  // factory DST transition. Timestamps carrying an explicit offset parse
  // absolutely.
  const factoryWallClockAt = (epochMs: number) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: DEFAULT_FACTORY_TIME_ZONE,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(epochMs));
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  };

  // Known limitation: kiosks record naive local timestamps, so the two
  // occurrences of the repeated fall-back hour are indistinguishable in the
  // stored data - an interval contained entirely within that one repeated
  // hour per year cannot be ordered or measured exactly by ANY consumer
  // until kiosks record absolute instants (tracked in REMEDIATION P2-5).
  // Shifts merely spanning a transition are computed correctly.
  const instantMs = (timestamp: string) => {
    const match = timestamp.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/);
    if (!match) return new Date(timestamp).getTime();
    const wallMs = Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +(match[6] || 0));
    // Two-pass inversion: find the epoch whose factory wall-clock equals the
    // target, converging across DST offset changes.
    let guess = wallMs;
    for (let i = 0; i < 2; i += 1) {
      guess = wallMs - (factoryWallClockAt(guess) - guess);
    }
    return guess;
  };

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
    const header = 'Time,Worker,Department,Event,Kiosk,Source,Correction Reason\n';
    const rows = events.map((e) =>
      [e.timestamp, e.worker_name, e.worker_department, e.event_type, e.kiosk_name || '', e.source || 'kiosk', e.correction_reason || ''].map(csvField).join(',')
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

    const startsOnSelectedDate = (timestamp: string) => timestamp.startsWith(date);
    const byWorker = new Map<string, { name: string; department: string; events: AttendanceWithWorker[] }>();
    for (const event of [...events, ...boundaryEvents].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) {
      const entry = byWorker.get(event.worker_id) || {
        name: event.worker_name || event.worker_id,
        department: event.worker_department || '',
        events: [],
      };
      entry.events.push(event);
      byWorker.set(event.worker_id, entry);
    }

    const rows: string[] = [];
    for (const entry of byWorker.values()) {
      let totalMs = 0;
      let firstIn: string | null = null;
      let lastOut: string | null = null;
      let openIn: string | null = null;
      for (const event of entry.events) {
        if (event.event_type === 'clock_in') {
          // Only shifts STARTING on the selected date belong to this export
          // (next-day clock-ins are that day's shifts), and keep the FIRST
          // unmatched clock-in: entry kiosks can emit repeat clock_ins, and
          // replacing the open interval's start would undercount hours.
          if (!openIn && startsOnSelectedDate(event.timestamp)) {
            openIn = event.timestamp;
            if (!firstIn) firstIn = event.timestamp;
          }
        } else if (event.event_type === 'clock_out' && openIn) {
          // A clock_out closes the open interval even after midnight.
          totalMs += instantMs(event.timestamp) - instantMs(openIn);
          lastOut = event.timestamp;
          openIn = null;
        }
      }
      // Workers with no shift starting on this date (e.g. only an overnight
      // clock_out counted on the previous day's export) are omitted.
      if (!firstIn && !openIn && totalMs === 0) continue;
      const hours = totalMs > 0 ? (totalMs / 3_600_000).toFixed(2) : '0.00';
      rows.push([entry.name, entry.department, firstIn || '', lastOut || '', hours, openIn ? 'still clocked in' : ''].map(csvField).join(','));
    }

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
            onChange={(e) => setDate(e.target.value)}
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

      {loading ? (
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
                </tr>
              </thead>
              <tbody>
                {corrections.map((correction) => (
                  <tr key={correction.id} className="border-b border-navy-700/30 table-row-hover">
                    <td className="px-5 py-3">
                      <span className="badge border border-gold/20 bg-gold/10 text-gold text-[11px]">{correctionLabel(correction.action)}</span>
                    </td>
                    <td className="px-5 py-3">
                      <div className="font-display font-medium text-slate-200">{correction.worker_name || correction.worker_id}</div>
                      <div className="text-[11px] font-mono text-slate-500">{correction.worker_department}</div>
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-slate-400">
                      {new Date(correctionTimestamp(correction)).toLocaleString()}
                    </td>
                    <td className="px-5 py-3 text-slate-400">{correction.reason}</td>
                    <td className="px-5 py-3 text-xs text-slate-500">{correction.supervisor_name || 'Not recorded'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
