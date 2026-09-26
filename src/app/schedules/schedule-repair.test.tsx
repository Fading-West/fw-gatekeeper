import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import SchedulesPage from './page';
import type { Schedule } from '@/lib/types';

const role = vi.hoisted(() => ({ current: 'admin' }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => role.current }));

let tree: ReactTestRenderer | undefined;
afterEach(async () => {
  if (tree) await act(async () => tree!.unmount());
  tree = undefined;
  role.current = 'admin';
  vi.unstubAllGlobals();
});

it('shows malformed stored weekdays as escaped text to review-only users', async () => {
  role.current = 'viewer';
  const legacyDays = '<script>alert(1)</script>';
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, json: async () => [schedule('legacy', legacyDays)],
  })));
  await act(async () => { tree = create(<SchedulesPage />); });

  const days = tree!.root.findAllByType('span').find(node =>
    text(node).includes('Invalid days:'))!;
  expect(text(days)).toContain(`Invalid days: ${legacyDays}`);
  expect(renderToStaticMarkup(<span>{days.props.children}</span>)).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(tree!.root.findAllByType('script')).toHaveLength(0);
  expect(tree!.root.findAllByType('button').some(node => node.props.className === 'btn-ghost text-xs')).toBe(false);
});

const text = (node: any): string => typeof node === 'string' ? node : (node.children ?? []).map(text).join('');
const schedule = (id: string, days: string): Schedule => ({
  id, name: `Schedule ${id}`, days, start_time: '06:00', end_time: '14:30',
  department: null, active: 1, created_at: '2026-09-01T00:00:00Z',
});

it('shows the exact invalid stored weekdays during repair and clears the notice for valid edits', async () => {
  const legacyDays = '[1,"Tuesday",<script>alert(1)</script>]';
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true,
    json: async () => url === '/api/schedules'
      ? [schedule('legacy', legacyDays), schedule('valid', '[1,2,3]')]
      : [],
  })));
  await act(async () => { tree = create(<SchedulesPage />); });

  const editButtons = tree!.root.findAllByType('button').filter(button =>
    button.props.className === 'btn-ghost text-xs');
  await act(async () => editButtons[0].props.onClick());
  const repairNotice = tree!.root.findAllByProps({ role: 'alert' }).find(node =>
    text(node).includes('Stored value:'));
  expect(repairNotice).toBeDefined();
  expect(text(repairNotice)).toContain(legacyDays);
  expect(tree!.root.findAllByType('script')).toHaveLength(0);
  expect(tree!.root.findAllByType('button').find(button => text(button) === 'Update Schedule')!.props.disabled).toBe(true);

  await act(async () => editButtons[1].props.onClick());
  expect(tree!.root.findAllByProps({ role: 'alert' }).some(node => text(node).includes('Stored value:'))).toBe(false);
  expect(tree!.root.findAllByType('button').find(button => text(button) === 'Update Schedule')!.props.disabled).toBe(false);
});
