import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'admin' }));
vi.mock('@/hooks/useScheduleActor', () => ({ useScheduleActor: () => 'synthetic-admin' }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
import SchedulesPage from './page';
let tree: ReactTestRenderer | undefined;
afterEach(async () => { if (tree) await act(async () => tree!.unmount()); tree = undefined; vi.unstubAllGlobals(); });
const text = (node: any): string => typeof node === 'string' ? node : (node.children ?? []).map(text).join('');
it('retains a conflicted draft until the administrator explicitly reloads current values', async () => {
  const old = { id: 'synthetic', name: 'Old schedule', days: '[1]', start_time: '06:00', end_time: '14:30', department: null, active: 1, created_at: '2026-10-02', revision: 0 };
  let loads = 0; let sent: Record<string, unknown> | undefined;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') { sent = JSON.parse(init.body as string); return Response.json({ error: 'Schedule changed' }, { status: 409 }); }
    if (url === '/api/workers') return Response.json([]);
    loads++;
    return Response.json([{ ...old, ...(loads > 1 ? { name: 'Current schedule', revision: 1 } : {}) }]);
  }));
  await act(async () => { tree = create(<SchedulesPage />); });
  await act(async () => tree!.root.findAllByType('button').find(button => button.props.className === 'btn-ghost text-xs')!.props.onClick());
  await act(async () => tree!.root.findAllByType('input').find(input => input.props.value === 'Old schedule')!.props.onChange({ target: { value: 'My draft' } }));
  await act(async () => tree!.root.findAllByType('button').find(button => text(button) === 'Update Schedule')!.props.onClick());
  expect(sent).toMatchObject({ name: 'My draft', expected_revision: 0 });
  expect(tree!.root.findAllByType('input').some(input => input.props.value === 'My draft')).toBe(true);
  await act(async () => tree!.root.findAllByType('button').find(button => text(button) === 'Load current schedule')!.props.onClick());
  expect(tree!.root.findAllByType('input').some(input => input.props.value === 'Current schedule')).toBe(true);
});
