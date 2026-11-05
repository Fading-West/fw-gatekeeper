import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CloseoutPage from './page';
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('date=2026-09-03') }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'admin' }));
const actor = vi.hoisted(() => ({ id: 'synthetic-refresh-0', next: 0 }));
vi.mock('@/hooks/useCloseoutActor', () => ({ useCloseoutActor: () => actor.id }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
const label = (node: any): string => typeof node === 'string' ? node : (node?.children || []).map(label).join('');
let tree: ReactTestRenderer;
beforeEach(() => { actor.id = `synthetic-refresh-${++actor.next}`; });
afterEach(async () => { if (tree) await act(async () => tree.unmount()); vi.unstubAllGlobals(); });

const read = (blockerEvidence: string, closeout: object) => ({ ok: true, json: async () => ({ date: '2026-09-03', closeout, blocker_evidence: blockerEvidence,
  summary: { critical_exceptions: 1 }, checklist: [], action_links: [], can_complete: false,
  attendance_queue: { scope: 'current_fleet', attendance_dates_known: false, captured_at: '2026-09-03T20:00:00.000Z', note: 'Clear',
    affected_kiosks: 0, pending_records: 0, unknown_kiosks: 0, kiosks: [] },
  blockers: [{ id: 'critical_exceptions', label: 'Critical exceptions', count: 1, description: 'Open', href: '/exceptions' }] }) });
const field = () => ({
  notes: () => tree.root.findByType('textarea').props.value,
  name: () => tree.root.findAllByType('input').find(node => node.props.placeholder === 'Supervisor name')!.props.value,
  ticked: () => tree.root.findAllByType('input').find(node => node.props.type === 'checkbox')!.props.checked,
  button: (text: string) => tree.root.findAllByType('button').find(node => label(node) === text)!,
});

async function draftThenRefresh(reads: object[]) {
  let index = 0;
  vi.stubGlobal('fetch', vi.fn(async () => reads[Math.min(index++, reads.length - 1)]));
  await act(async () => { tree = create(<CloseoutPage />); });
  const page = field();
  await act(async () => tree.root.findByType('textarea').props.onChange({ target: { value: 'Two drivers left early; approved by plant manager' } }));
  await act(async () => tree.root.findAllByType('input').find(node => node.props.placeholder === 'Supervisor name')!.props.onChange({ target: { value: 'Dana' } }));
  await act(async () => tree.root.findAllByType('input').find(node => node.props.type === 'checkbox')!.props.onChange({ target: { checked: true } }));
  expect(page.button('Complete closeout').props.disabled).toBe(false);
  await act(async () => page.button('Refresh').props.onClick());
  return page;
}

it('keeps the unsaved signoff draft and acknowledgement when Refresh returns the same record', async () => {
  const open = { status: 'open', revision: 2, notes: '', supervisor_name: '', acknowledged_blockers: false };
  const page = await draftThenRefresh([read('blockers-a', open), read('blockers-a', open)]);
  expect(page.notes()).toBe('Two drivers left early; approved by plant manager');
  expect(page.name()).toBe('Dana');
  expect(page.ticked()).toBe(true);
  expect(page.button('Complete closeout').props.disabled).toBe(false);
});

it('keeps the draft text but clears the acknowledgement when the blockers changed', async () => {
  const open = { status: 'open', revision: 2, notes: '', supervisor_name: '', acknowledged_blockers: false };
  const page = await draftThenRefresh([read('blockers-a', open), read('blockers-b', open)]);
  expect(page.notes()).toBe('Two drivers left early; approved by plant manager');
  expect(page.name()).toBe('Dana');
  expect(page.ticked()).toBe(false);
});

it('loads the saved record when someone else changed it before Refresh', async () => {
  const page = await draftThenRefresh([
    read('blockers-a', { status: 'open', revision: 2, notes: '', supervisor_name: '', acknowledged_blockers: false }),
    read('blockers-a', { status: 'open', revision: 3, notes: 'Saved by another supervisor', supervisor_name: 'Riley', acknowledged_blockers: false }),
  ]);
  expect(page.notes()).toBe('Saved by another supervisor');
  expect(page.name()).toBe('Riley');
  expect(page.ticked()).toBe(false);
});
