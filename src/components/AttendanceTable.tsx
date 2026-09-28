'use client';

import { AttendanceWithWorker } from '@/lib/types';

export function attendanceRowId(id: string) {
  return `attendance-row-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

export default function AttendanceTable({
  events,
  targetAttendanceId = '',
}: {
  events: AttendanceWithWorker[];
  targetAttendanceId?: string;
}) {
  if (events.length === 0) {
    return (
      <div className="text-center py-16">
        <svg className="w-12 h-12 text-slate-600 mx-auto mb-3" fill="none" viewBox="0 0 24 24" strokeWidth={1} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
        </svg>
        <p className="text-slate-500 font-display">No records for this date</p>
        <p className="text-xs text-slate-600 mt-1">Select a different date to view activity</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-navy-600/50">
            <th className="text-left py-3.5 px-4 section-label">Time</th>
            <th className="text-left py-3.5 px-4 section-label">Worker</th>
            <th className="text-left py-3.5 px-4 section-label">Event</th>
            <th className="text-left py-3.5 px-4 section-label">Kiosk</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => {
            const targeted = targetAttendanceId === e.id;
            return (
              <tr
                id={attendanceRowId(e.id)}
                key={e.id}
                className={`border-b border-navy-700/30 table-row-hover transition-colors ${targeted ? 'bg-gold/5 ring-1 ring-inset ring-gold/30' : ''}`}
              >
                <td className="py-3 px-4 font-mono text-xs text-slate-400 tabular-nums">
                  {new Date(e.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </td>
                <td className="py-3 px-4">
                  <div className="font-display font-medium text-slate-200 text-sm">{e.worker_name}</div>
                  <div className="text-[11px] font-mono text-slate-500">{e.worker_department}</div>
                  {e.corrected && (
                    <div className="mt-1 text-[11px] text-gold">
                      Supervisor correction{e.correction_reason ? `: ${e.correction_reason}` : ''}
                    </div>
                  )}
                </td>
                <td className="py-3 px-4">
                  <span className={`badge text-[11px] border ${
                    e.event_type === 'clock_in'
                      ? 'bg-emerald-400/10 text-emerald-400 border-emerald-400/20'
                      : 'bg-amber-400/10 text-amber-400 border-amber-400/20'
                  }`}>
                    {e.event_type === 'clock_in' ? (
                      <>
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 13.5L12 21m0 0l-7.5-7.5M12 21V3" />
                        </svg>
                        Clock In
                      </>
                    ) : (
                      <>
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5L12 3m0 0l7.5 7.5M12 3v18" />
                        </svg>
                        Clock Out
                      </>
                    )}
                  </span>
                </td>
                <td className="py-3 px-4 text-xs font-mono text-slate-500">
                  {e.kiosk_name || '—'}
                  {e.note === 'manual_clock' && (
                    <span className="ml-2 rounded-full border border-gold/20 bg-gold/10 px-2 py-0.5 text-[10px] text-gold">
                      Manual clock
                    </span>
                  )}
                  {e.source === 'correction' && (
                    <span className="ml-2 rounded-full border border-gold/20 bg-gold/10 px-2 py-0.5 text-[10px] text-gold">
                      corrected
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
