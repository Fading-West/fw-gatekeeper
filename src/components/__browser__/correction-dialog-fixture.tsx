// Browser fixture for AttendanceCorrectionDialog.browser.test.ts: renders the
// real dialog over focusable background controls with a controllable fetch.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import AttendanceCorrectionDialog from '../AttendanceCorrectionDialog';
import type { AttendanceWithWorker } from '@/lib/types';

type Fixture = { resolvePost: (status: number) => void; closed: number };
const fixture = window as unknown as Window & { __fixture: Fixture };

let pendingPost: ((response: Response) => void) | null = null;
window.fetch = (() => new Promise<Response>((resolve) => { pendingPost = resolve; })) as typeof fetch;
fixture.__fixture = {
  closed: 0,
  resolvePost(status: number) {
    pendingPost?.(new Response(JSON.stringify(status < 400 ? { id: 'correction-1' } : { error: 'Unauthorized' }), { status }));
    pendingPost = null;
  },
};

const rawScan: AttendanceWithWorker = {
  id: 'raw-1', worker_id: 'worker-1', event_type: 'clock_in', kiosk_id: 'entry', timestamp: '2026-09-14T08:00:00',
  synced: 1, source: 'kiosk', worker_name: 'Worker One', worker_department: 'Assembly', kiosk_name: 'Entry Kiosk',
};

function App() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" id="background-before">Background before</button>
      {open && (
        <AttendanceCorrectionDialog
          date="2026-09-14"
          mode="void"
          sourceEvent={rawScan}
          effectiveEvents={[rawScan]}
          ready
          now={() => new Date('2026-09-14T22:00:00Z')}
          onPendingStart={() => {}}
          onPendingSettled={() => {}}
          onSaved={() => {}}
          onClose={() => { fixture.__fixture.closed += 1; setOpen(false); }}
        />
      )}
      <button type="button" id="background-after">Background after</button>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
