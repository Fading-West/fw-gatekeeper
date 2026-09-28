import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CloseoutPage from './page';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('date=2026-09-10') }));
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'admin' }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
const label = (node: any): string => typeof node === 'string' ? node : (node?.children || []).map(label).join('');
const payload = (date: string, notes: string) => ({ date, closeout: { status: 'open', notes }, summary: {}, checklist: [], blockers: [], action_links: [], can_complete: true });
const response = (data: unknown) => ({ ok: true, json: async () => data });
let tree: ReactTestRenderer;
let requests: Map<string, (data: unknown) => void>;
let fetchMock: ReturnType<typeof vi.fn>;
const button = (text: string) => tree.root.findAllByType('button').find((node) => label(node) === text)!;

beforeEach(async () => {
  requests = new Map();
  fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => new Promise((resolve) => { requests.set(init?.method === 'PATCH' ? 'PATCH' : url, (data) => resolve(response(data))); }));
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => { tree = create(<CloseoutPage />); });
});
afterEach(async () => { await act(async () => tree.unmount()); vi.unstubAllGlobals(); });

it('cannot sign off or export a previous date while the new date loads', async () => {
  await act(async () => requests.get('/api/shift-closeout?date=2026-09-10')!(payload('2026-09-10', 'Thursday notes')));
  expect(tree.root.findByType('textarea').props.value).toBe('Thursday notes');
  await act(async () => tree.root.findAllByType('input').find((node) => node.props.type === 'date')!.props.onChange({ target: { value: '2026-09-11' } }));
  expect(button('Save notes').props.disabled).toBe(true);
  expect(button('Export').props.disabled).toBe(true);
  expect(tree.root.findByType('textarea').props.value).toBe('');
  await act(async () => button('Save notes').props.onClick());
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  await act(async () => requests.get('/api/shift-closeout?date=2026-09-11')!(payload('2026-09-11', 'Friday notes')));
  expect(tree.root.findByType('textarea').props.value).toBe('Friday notes');
});

it('keeps React 18 save controls disabled until the network request and refresh finish', async () => {
  await act(async () => requests.get('/api/shift-closeout?date=2026-09-10')!(payload('2026-09-10', 'Notes')));
  const handler = button('Save notes').props.onClick;
  await act(async () => { handler(); handler(); });
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
  expect(button('Save notes').props.disabled).toBe(true);
  expect(tree.root.findByType('textarea').props.readOnly).toBe(true);
  await act(async () => requests.get('PATCH')!({}));
  expect(button('Save notes').props.disabled).toBe(true);
  await act(async () => requests.get('/api/shift-closeout?date=2026-09-10')!(payload('2026-09-10', 'Notes')));
  expect(button('Save notes').props.disabled).toBe(false);
});

it('locks completed notes and exports the signed summary instead of later source changes', async () => {
  const data = {
    ...payload('2026-09-10', 'Signed notes'),
    closeout: { status: 'completed', notes: 'Signed notes', snapshot: { expected: 9, present: 8, late: 1, missing: 0, open_exceptions: 0, critical_exceptions: 0, kiosk_warnings: 0 } },
    summary: { expected: 123, attendance_corrections: 2 },
  };
  await act(async () => requests.get('/api/shift-closeout?date=2026-09-10')!(data));
  expect(button('Save notes').props.disabled).toBe(true);
  expect(tree.root.findByType('textarea').props.readOnly).toBe(true);
  let exported!: Blob;
  vi.stubGlobal('URL', { createObjectURL: (blob: Blob) => { exported = blob; return 'blob:test'; }, revokeObjectURL: vi.fn() });
  vi.stubGlobal('document', { createElement: () => ({ click: vi.fn() }) });
  await act(async () => button('Export').props.onClick());
  const text = await exported.text();
  expect(text).toContain('Signed summary\nExpected: 9');
  expect(text).not.toContain('Expected: 123');
});
