import { expect, it } from 'vitest';
import { buildHoursExportRows } from './attendance-hours';
import { buildAttendanceExportCSV, buildHoursExportCSV } from './attendance-export';
import type { AttendanceWithWorker } from './types';
const date = '2026-10-02';
function event(workerId: string, id: string, timestamp: string, eventType: 'clock_in' | 'clock_out', extra: Partial<AttendanceWithWorker> = {}): AttendanceWithWorker {
  return { worker_id: workerId, id, timestamp, event_type: eventType, worker_name: 'Same name', worker_department: 'Mill', kiosk_id: null, synced: 1, ...extra };
}
it('retains worker, event and correction identifiers independently of labels and absent roster data', () => {
  const raw = event('stable-worker', 'raw-event', `${date}T08:00:00`, 'clock_in');
  const correction = event('stable-worker', 'correction:stable-correction', `${date}T16:00:00`, 'clock_out', { source: 'correction', correction_id: 'stable-correction', worker_employee_id: 'E-1' });
  const before = buildAttendanceExportCSV([raw, correction]).split('\n');
  const after = buildAttendanceExportCSV([{ ...raw, worker_name: 'Renamed' }, { ...correction, worker_name: 'Renamed', worker_employee_id: 'E-2' }]).split('\n');
  expect(before[0].endsWith('Worker ID,Event ID,Correction ID,Employee ID')).toBe(true);
  expect(before[1].endsWith(',stable-worker,raw-event,,')).toBe(true);
  expect(before[2].endsWith(',stable-worker,correction:stable-correction,stable-correction,E-1')).toBe(true);
  expect(after[2].endsWith(',stable-worker,correction:stable-correction,stable-correction,E-2')).toBe(true);
  expect(buildAttendanceExportCSV([{ ...raw, worker_name: '' }])).toContain(',stable-worker,raw-event,,');
});
it('keeps same-name workers separate and preserves overnight totals and ambiguous withholding', () => {
  const selected = [
    event('worker-a', 'a-in', `${date}T22:00:00`, 'clock_in', { worker_employee_id: 'E-A' }),
    event('worker-b', 'b-in', `${date}T08:00:00`, 'clock_in'),
  ];
  const boundary = [
    event('worker-a', 'a-out', '2026-10-03T06:00:00', 'clock_out'),
    event('worker-b', 'b-next-in', '2026-10-03T08:00:00', 'clock_in'),
  ];
  const rows = buildHoursExportRows(selected, boundary, date);
  expect(rows).toHaveLength(2);
  expect(rows.find(row => row.workerId === 'worker-a')).toMatchObject({ employeeId: 'E-A', hours: '8.00', ambiguous: false });
  expect(rows.find(row => row.workerId === 'worker-b')).toMatchObject({ employeeId: '', hours: '', ambiguous: true });
  const csv = buildHoursExportCSV(rows);
  expect(csv).toContain(',8.00,,worker-a,E-A');
  expect(csv).toContain('hours withheld,worker-b,');
});
it('applies the inherited CSV sanitizer to supplemental employee IDs and every new identifier cell', () => {
  const csv = buildAttendanceExportCSV([event('＝1+1', '@event', `${date}T08:00:00`, 'clock_in', { correction_id: '+correction', worker_employee_id: '=employee' })]);
  expect(csv).toContain(",'＝1+1,'@event,'+correction,'=employee");
});
