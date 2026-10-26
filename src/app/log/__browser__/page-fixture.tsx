import { createRoot } from 'react-dom/client';
import LogPage from '../page';
import '../../globals.css';

const raw = {
  id: 'raw-1', worker_id: 'worker-1', worker_name: 'Worker One', worker_department: 'Assembly', event_type: 'clock_in',
  kiosk_id: 'entry', kiosk_name: 'Entry', timestamp: '2026-09-14T08:00:00', synced: 1, source: 'kiosk',
};
let post: ((value: Response) => void) | null = null;
let holdRefresh = false;
let rows = [raw];
const refresh: (() => void)[] = [];
const fixture = {
  posts: 0,
  resolvePost() {
    holdRefresh = true;
    post?.(Response.json({ id: 'correction-1' }, { status: 201 }));
    post = null;
  },
  resolveRefresh(removeRaw: boolean) {
    if (removeRaw) rows = [];
    holdRefresh = false;
    refresh.splice(0).forEach((resolve) => resolve());
  },
};
(window as unknown as { __fixture: typeof fixture }).__fixture = fixture;
window.fetch = ((url: string, options?: RequestInit) => {
  if (options?.method === 'POST') {
    fixture.posts += 1;
    return new Promise<Response>((resolve) => { post = resolve; });
  }
  if (url.startsWith('/api/workers')) return Promise.resolve(Response.json([
    { id: 'worker-1', name: 'Worker One', department: 'Assembly', active: 1, photo_url: null, enrolled_at: '' },
  ]));
  const response = () => Response.json(url.startsWith('/api/attendance-corrections') ? { corrections: [] } : rows);
  if (holdRefresh) return new Promise<Response>((resolve) => { refresh.push(() => resolve(response())); });
  return Promise.resolve(response());
}) as typeof fetch;

createRoot(document.getElementById('root')!).render(<LogPage />);
