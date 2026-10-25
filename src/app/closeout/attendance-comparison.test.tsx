import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CloseoutPage from './page';
import { ATTENDANCE_SCOPE } from '@/lib/attendance-comparison';

const state = vi.hoisted(() => ({ role: 'admin' }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('date=2026-09-02') }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => state.role }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
const label = (node: any): string => typeof node === 'string' ? node : (node?.children || []).map(label).join('');
const summary = { expected: 9, present: 8, late: 1, missing: 1, open_exceptions: 0, critical_exceptions: 0, kiosk_warnings: 0 };
const signed = { version: 1, digest: 'a'.repeat(64), raw_punches: 2, corrections: 0, reversals: 0 };
const unchanged = { status: 'unchanged', scope: ATTENDANCE_SCOPE, compared_at: '2026-09-03T01:00:00Z', signed, current: signed };
const payload = (comparison: unknown = unchanged) => ({ date: '2026-09-02', generated_at: '2026-09-03T01:00:00Z',
  closeout: { status: 'completed', notes: 'Original signed note', completed_at: '2026-09-02T22:00:00Z', snapshot: summary },
  summary: { ...summary, expected: 12, attendance_corrections: 0 }, attendance_comparison: comparison,
  checklist: [], blockers: [], action_links: [], can_complete: true,
});
let tree: ReactTestRenderer;
let requests: Array<(value: unknown) => void>;
let fetchMock: ReturnType<typeof vi.fn>;
const button = (text: string) => tree.root.findAllByType('button').find(node => label(node) === text)!;
const text = () => label(tree.toJSON());

beforeEach(async () => {
  state.role = 'admin';
  requests = [];
  fetchMock = vi.fn().mockImplementation(() => new Promise(resolve => { requests.push(resolve); }));
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => { tree = create(<CloseoutPage />); });
});
afterEach(async () => { await act(async () => tree.unmount()); vi.unstubAllGlobals(); });
async function respond(data: unknown, index = requests.length - 1) {
  await act(async () => requests[index]({ ok: true, json: async () => data }));
}

it('warns on equal-count evidence changes, keeps signed/current totals distinct and exports both', async () => {
  await respond(payload({ ...unchanged, status: 'changed', current: { ...signed, digest: 'b'.repeat(64) } }));
  expect(text()).toContain('Attendance changed since signoff');
  expect(text()).not.toContain('Shift closeout complete');
  expect(text()).toContain('Completed');
  expect(label(tree.root.findByProps({ 'aria-label': 'Signed summary' }))).toContain('Expected9');
  expect(label(tree.root.findByProps({ 'aria-label': 'Current summary' }))).toContain('Expected12');
  expect(tree.root.findAllByType('a').some(node => node.props.href === '/log?date=2026-09-02' && label(node).includes('Review attendance'))).toBe(true);
  expect(button('Reopen').props.disabled).toBe(false);
  let exported!: Blob;
  vi.stubGlobal('URL', { createObjectURL: (blob: Blob) => { exported = blob; return 'blob:test'; }, revokeObjectURL: vi.fn() });
  vi.stubGlobal('document', { createElement: () => ({ click: vi.fn() }) });
  await act(async () => button('Export').props.onClick());
  const exportedText = await exported.text();
  expect(exportedText).toContain('Attendance changed since signoff');
  expect(exportedText).toContain(ATTENDANCE_SCOPE);
  expect(exportedText).toContain('Signed summary\nExpected: 9');
  expect(exportedText).toContain('Current summary\nExpected: 12');
  expect(exportedText).toContain('Original signed note');
});

it('shows legacy and unsupported comparison as unknown while preserving the signed summary', async () => {
  await respond(payload(undefined));
  // Explicitly remove the field: a default argument above otherwise provides equality.
  await act(async () => { void button('Refresh').props.onClick(); });
  const legacy = payload();
  delete (legacy as Partial<typeof legacy>).attendance_comparison;
  await respond(legacy);
  expect(text()).toContain('Signed closeout — attendance comparison unavailable');
  expect(text()).not.toContain('No attendance evidence changes detected');
  expect(tree.root.findByType('textarea').props.value).toBe('Original signed note');
  expect(tree.root.findByProps({ 'aria-label': 'Signed summary' })).toBeTruthy();
});

it('removes equality during loading, failure and date switches, ignoring late old responses', async () => {
  await respond(payload());
  expect(text()).toContain('No attendance evidence changes detected');
  await act(async () => { void button('Refresh').props.onClick(); });
  const staleIndex = requests.length - 1;
  expect(text()).not.toContain('No attendance evidence changes detected');
  expect(button('Export').props.disabled).toBe(true);
  await act(async () => tree.root.findAllByType('input').find(node => node.props.type === 'date')!.props.onChange({ target: { value: '2026-09-03' } }));
  await respond(payload(), staleIndex);
  expect(text()).not.toContain('No attendance evidence changes detected');
  await act(async () => requests[requests.length - 1]({ ok: false, json: async () => ({ error: 'Temporary failure' }) }));
  expect(text()).toContain('Temporary failure');
  expect(text()).not.toContain('No attendance evidence changes detected');
  expect(button('Export').props.disabled).toBe(true);
});

it('keeps viewer review links and hides reopen and write controls', async () => {
  state.role = 'viewer';
  await respond(payload({ ...unchanged, status: 'changed', current: { ...signed, digest: 'b'.repeat(64) } }));
  expect(text()).toContain('Attendance changed since signoff');
  expect(button('Review-only')).toBeTruthy();
  expect(button('Reopen')).toBeUndefined();
  expect(tree.root.findByType('textarea').props.readOnly).toBe(true);
  expect(fetchMock.mock.calls).toHaveLength(1);
});
