import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@/hooks/usePortalRole', () => ({ usePortalRole: () => 'admin' }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
import WorkersPage from './page';

type Node = ReactTestRendererJSON | ReactTestRendererJSON[] | string | null;
const text = (node: Node): string => node === null ? '' : typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join(' ') : (node.children || []).map(text).join('');
function worker(id: string, encoding_status: 'valid' | 'missing' | 'invalid', active: number) {
  return { id, name: id, employee_id: id, department: 'Synthetic', photo_url: null, has_face_encoding: encoding_status === 'valid', encoding_status, enrolled_at: '2026-10-02T08:00:00Z', active };
}
let tree: ReactTestRenderer | undefined;
afterEach(async () => { if (tree) await act(async () => tree!.unmount()); tree = undefined; vi.unstubAllGlobals(); });

it('does not count inactive workers as recognition ready or needing enrollment', async () => {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url === '/api/kiosks') return Promise.resolve(Response.json([]));
    if (url.includes('active=false')) return Promise.resolve(Response.json([
      worker('Former retained A', 'valid', 0),
      worker('Former retained B', 'valid', 0),
      worker('Former purged', 'missing', 0),
    ]));
    return Promise.resolve(Response.json([worker('Current ready', 'valid', 1), worker('Current missing', 'missing', 1)]));
  }));
  await act(async () => { tree = create(<WorkersPage />); });
  const active = text(tree!.toJSON());
  expect(active).toContain('2 registered workers · 1 face enrolled · 1 needs enrollment · 0 invalid');
  expect(active).toContain('Face enrolled and ready for kiosk recognition.');

  await act(async () => tree!.root.findAllByType('input').find(input => input.props.type === 'checkbox')!.props.onChange({ target: { checked: true } }));
  const inactive = text(tree!.toJSON());
  expect(inactive).toContain('Inactive — excluded from kiosk recognition');
  expect(inactive).not.toContain('ready for kiosk recognition');
  expect(inactive).not.toContain('Recognition ready');
  expect(inactive).not.toContain('use Enroll Face before kiosk use');
  expect(inactive).not.toContain('face enrolled ·');
  expect(inactive).toContain('3 inactive workers · 2 with retained face data');
});
