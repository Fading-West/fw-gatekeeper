import type { AttendanceWithWorker } from './types';
import type { HoursExportRow } from './attendance-hours';
import { csvField } from './csv';

/** Keep existing columns in place; append identifiers for reliable record matching. */
export function buildAttendanceExportCSV(events: AttendanceWithWorker[]): string {
  const header = 'Time,Worker,Department,Event,Kiosk,Source,Correction Reason,Note,Worker ID,Event ID,Correction ID,Employee ID\n';
  const rows = events.map(event => [
    event.timestamp, event.worker_name, event.worker_department, event.event_type,
    event.kiosk_name || '', event.source || 'kiosk', event.correction_reason || '', event.note || '',
    event.worker_id, event.id, event.correction_id || '', event.worker_employee_id || '',
  ].map(csvField).join(','));
  return header + rows.join('\n');
}

export function buildHoursExportCSV(rows: HoursExportRow[]): string {
  const header = 'Worker,Department,First In,Last Out,Hours,Note,Worker ID,Employee ID\n';
  return header + rows.map(row => [
    row.name, row.department, row.firstIn, row.lastOut, row.hours, row.note, row.workerId, row.employeeId,
  ].map(csvField).join(',')).join('\n');
}
