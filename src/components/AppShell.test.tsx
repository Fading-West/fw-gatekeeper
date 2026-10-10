import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AppShell from './AppShell';

const { state, replace } = vi.hoisted(() => ({
  state: { pathname: '/', member: undefined as { mustChangePassword: boolean } | undefined }, replace: vi.fn(),
}));
vi.mock('next/navigation', () => ({ usePathname: () => state.pathname, useRouter: () => ({ replace }) }));
vi.mock('convex/react', () => ({ useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }), useQuery: () => state.member }));
vi.mock('./Sidebar', () => ({ default: () => <aside>Sidebar</aside> }));
vi.mock('./GuideDrawer', () => ({ default: () => null }));
beforeEach(() => { state.pathname = '/'; state.member = undefined; vi.clearAllMocks(); });
afterEach(() => vi.unstubAllGlobals());

it('waits for member state before mounting protected queries and redirects on a live reset', async () => {
  const mounted = vi.fn();
  function Protected() { mounted(); return <p>Protected page</p>; }
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<AppShell><Protected /></AppShell>); });
  try {
    expect(mounted).not.toHaveBeenCalled();
    state.member = { mustChangePassword: false };
    await act(async () => tree.update(<AppShell><Protected /></AppShell>));
    expect(mounted).toHaveBeenCalledTimes(1);
    state.member = { mustChangePassword: true };
    await act(async () => tree.update(<AppShell><Protected /></AppShell>));
    expect(tree.root.findAllByType(Protected)).toHaveLength(0);
    expect(replace).toHaveBeenCalledWith('/change-password');
  } finally { await act(async () => tree.unmount()); }
});

it('shows only the change form when rotation is required and the route has arrived', async () => {
  state.pathname = '/change-password';
  state.member = { mustChangePassword: true };
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<AppShell><p>Change form</p></AppShell>); });
  try {
    expect(tree.root.findAllByType('aside')).toHaveLength(0);
    expect(tree.root.findByType('p').children).toEqual(['Change form']);
    expect(replace).not.toHaveBeenCalled();
  } finally { await act(async () => tree.unmount()); }
});
