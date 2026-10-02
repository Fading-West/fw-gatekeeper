import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import BriefingPage from './page';
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('date=2026-09-03') }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'enrollment' }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
const label = (node: any): string => typeof node === 'string' ? node : (node?.children || []).map(label).join('');
let tree: ReactTestRenderer;
afterEach(async () => { if (tree) await act(async () => tree.unmount()); vi.unstubAllGlobals(); });
it('shows unavailable schedule reasons and exact worker activity without inventing an attendance status', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ date: '2026-09-03', generated_at: '2026-09-03T12:00:00Z', summary: {},
    departments: [], workers: [], action_items: [], kiosks: { total: 0, counts: {}, rows: [] }, schedules: { active_today: 2, total_active: 2 },
    schedule_assignment_warnings: [{ worker_id: 'synthetic-worker', worker_name: 'Synthetic worker', department: 'Assembly', kind: 'ambiguous', tier: 'department',
      candidates: [{ id: 'one', name: 'Assembly one', start: '08:00', end: '17:00' }, { id: 'two', name: 'Assembly two', start: '09:00', end: '18:00' }], event_count: 2 }] }) })));
  await act(async () => { tree = create(<BriefingPage />); });
  const section = tree.root.findByProps({ 'aria-label': 'Unavailable schedule assignments' });
  expect(label(section)).toContain('Multiple department schedules match');
  expect(label(section)).toContain('Assembly one');
  expect(label(section)).toContain('Assembly two');
  expect(label(section)).toContain('Unmatched workers are not presumed missing');
  expect(section.findAllByType('a').map(node => node.props.href)).toContain('/log?date=2026-09-03&worker_id=synthetic-worker');
});
