import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import AttendanceTable from './AttendanceTable';
import type { AttendanceWithWorker } from '@/lib/types';
const event: AttendanceWithWorker = { id: 'event', worker_id: 'worker', event_type: 'clock_in', kiosk_id: 'entry', timestamp: '2026-09-01T08:00:00', synced: 1, worker_name: 'Worker', worker_department: 'Operations', kiosk_name: 'Entry' };
it('identifies manual clocks without labeling legacy attendance as manual', () => {
  expect(renderToStaticMarkup(<AttendanceTable events={[{ ...event, note: 'manual_clock' }]} />)).toContain('Manual clock');
  expect(renderToStaticMarkup(<AttendanceTable events={[event]} />)).not.toContain('Manual clock');
});
