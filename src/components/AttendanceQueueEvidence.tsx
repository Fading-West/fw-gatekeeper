import type { AttendanceQueueEvidence, AttendanceQueueObservation } from '@/lib/types';

function formatObservedAt(value: string | null) {
  if (!value) return 'an unrecorded time';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function records(count: number) {
  return `${count} attendance record${count === 1 ? '' : 's'}`;
}

export function describeAttendanceQueue(queue: AttendanceQueueObservation | null | undefined) {
  if (!queue) return 'Not reported by this backend';
  if (queue.last_valid_count === null) return 'Queue count not reported';
  const observed = formatObservedAt(queue.observed_at);
  if (queue.status === 'pending') return `${records(queue.last_valid_count)} not yet uploaded (reported ${observed})`;
  if (queue.status === 'clear') return `No attendance waiting to upload (reported ${observed})`;
  return queue.caveat
    ? `Latest report had no valid count; last valid report was ${records(queue.last_valid_count)} not yet uploaded at ${observed}`
    : `Latest report had no valid count; last valid report showed none waiting at ${observed}`;
}

function summaryLine(evidence: AttendanceQueueEvidence) {
  return evidence.affected_kiosks
    ? `${evidence.affected_kiosks} kiosk${evidence.affected_kiosks === 1 ? '' : 's'} last reported ${records(evidence.pending_records)} not yet uploaded.`
    : 'No kiosk reported attendance waiting to upload.';
}

export function attendanceQueueExportLines(evidence: AttendanceQueueEvidence | null | undefined, missing: string) {
  if (!evidence) return [missing];
  return [
    `Captured: ${formatObservedAt(evidence.captured_at)}`,
    summaryLine(evidence),
    evidence.note,
    ...evidence.kiosks.map((kiosk) => `- ${kiosk.name} (${kiosk.kiosk_id || kiosk.id}): ${describeAttendanceQueue(kiosk)}`),
    ...(evidence.omitted_kiosks ? [`- ${evidence.omitted_kiosks} more kiosks not listed`] : []),
  ];
}

export function AttendanceQueueEvidencePanel({ title, evidence, missing, testId }: {
  title: string;
  evidence: AttendanceQueueEvidence | null | undefined;
  missing: string;
  testId: string;
}) {
  const tone = evidence?.affected_kiosks ? 'border-amber-400/20 bg-amber-400/5' : 'border-navy-600/50 bg-navy-900/35';
  return (
    <div data-testid={testId} className={`rounded-xl border p-4 ${evidence ? tone : 'border-amber-400/20 bg-amber-400/5'}`}>
      <p className="section-label">{title}</p>
      {!evidence ? (
        <p className="mt-2 text-sm text-amber-200">{missing}</p>
      ) : (
        <>
          <p className={`mt-2 text-sm ${evidence.affected_kiosks ? 'text-amber-200' : 'text-slate-300'}`}>{summaryLine(evidence)}</p>
          <p className="mt-1 text-xs leading-5 text-slate-400">{evidence.note}</p>
          {evidence.kiosks.length > 0 && (
            <ul className="mt-2 space-y-1">
              {evidence.kiosks.map((kiosk) => (
                <li key={kiosk.id} className={`text-xs ${kiosk.caveat ? 'text-amber-300' : 'text-slate-400'}`}>
                  {kiosk.name}: {describeAttendanceQueue(kiosk)}
                </li>
              ))}
              {evidence.omitted_kiosks ? <li className="text-xs text-slate-500">{evidence.omitted_kiosks} more kiosks not listed</li> : null}
            </ul>
          )}
          <p className="mt-2 text-[11px] text-slate-500">Captured {formatObservedAt(evidence.captured_at)}</p>
        </>
      )}
    </div>
  );
}
