import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import CloseoutPage from './page';
import { ATTENDANCE_SCOPE } from '@/lib/attendance-comparison';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('date=2026-11-06') }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'admin' }));
vi.mock('@/hooks/useCloseoutActor', () => ({ useCloseoutActor: () => 'synthetic-actor' }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));

const label = (node: any): string => typeof node === 'string' ? node : (node?.children || []).map(label).join('');
const flat = (value: string) => value.replace(/\s+/g, ' ');
// 5:00 PM in the factory (America/Chicago, CST); 11:00 PM UTC, 3:00 PM Pacific.
const completedAt = '2026-11-06T23:00:00.000Z';
const comparedAt = '2026-11-06T23:30:00.000Z';
const generatedAt = '2026-11-06T23:45:00.000Z';
const summary = { expected: 9, present: 9, late: 0, missing: 0, open_exceptions: 0, critical_exceptions: 0, kiosk_warnings: 0 };
const signed = { version: 1, digest: 'a'.repeat(64), raw_punches: 2, corrections: 0, reversals: 0 };
const payload = {
  date: '2026-11-06', generated_at: generatedAt,
  closeout: { status: 'completed', notes: 'Signed', completed_at: completedAt, snapshot: summary },
  closeout_draft: { generated_at: generatedAt, narrative: 'Draft', source_links: [], sections: [{ id: 'attendance_summary', title: 'Attendance', paragraph: 'All present.', source_links: [] }] },
  summary: { ...summary, attendance_corrections: 0 },
  attendance_comparison: { status: 'unchanged', scope: ATTENDANCE_SCOPE, compared_at: comparedAt, signed, current: signed },
  attendance_queue: { affected_kiosks: 0, kiosks: [] }, checklist: [], blockers: [], action_links: [], can_complete: true,
};

let tree: ReactTestRenderer | null = null;
afterEach(async () => {
  if (tree) await act(async () => tree!.unmount());
  tree = null;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each(['UTC', 'America/Los_Angeles', 'Asia/Tokyo'])('shows and exports closeout times in factory time for a %s viewer', async (timezone) => {
  vi.stubEnv('TZ', timezone);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => payload })));
  await act(async () => { tree = create(<CloseoutPage />); });
  const page = flat(label(tree!.toJSON()));
  expect(page).toContain('Completed Nov 6, 5:00 PM.');
  expect(page).toContain('Compared: Nov 6, 5:30 PM');
  expect(page).toContain('Generated from deterministic source counts at Nov 6, 5:45 PM.');

  let exported!: Blob;
  vi.stubGlobal('URL', { createObjectURL: (blob: Blob) => { exported = blob; return 'blob:test'; }, revokeObjectURL: vi.fn() });
  vi.stubGlobal('document', { createElement: () => ({ click: vi.fn() }) });
  const exportButton = tree!.root.findAllByType('button').find((node) => label(node) === 'Export')!;
  await act(async () => exportButton.props.onClick());
  expect(flat(await exported.text())).toContain('Completed: Nov 6, 5:00 PM');
});
