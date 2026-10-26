import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import AttendanceTable from './AttendanceTable';
import type { AttendanceWithWorker } from '@/lib/types';
const event: AttendanceWithWorker = { id: 'event', worker_id: 'worker', event_type: 'clock_in', kiosk_id: 'entry', timestamp: '2026-09-01T08:00:00', synced: 1, worker_name: 'Worker', worker_department: 'Operations', kiosk_name: 'Entry' };
it('identifies manual clocks without labeling legacy attendance as manual', () => {
  expect(renderToStaticMarkup(<AttendanceTable events={[{ ...event, note: 'manual_clock' }]} />)).toContain('Manual clock');
  expect(renderToStaticMarkup(<AttendanceTable events={[event]} />)).not.toContain('Manual clock');
});
it('renders no action column unless a caller provides row actions', () => {
  const plain = renderToStaticMarkup(<AttendanceTable events={[event]} />);
  expect(plain).not.toContain('>Action<');
  expect(plain.match(/<th /g)).toHaveLength(4);
  const withAction = renderToStaticMarkup(<AttendanceTable events={[event, { ...event, id: 'other' }]} renderRowAction={(row) => <button>Fix {row.id}</button>} />);
  expect(withAction).toContain('>Action<');
  expect(withAction).toContain('Fix event');
  expect(withAction).toContain('Fix other');
});
