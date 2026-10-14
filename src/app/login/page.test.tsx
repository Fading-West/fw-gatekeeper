import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
import LoginPage from './page';

const { signIn, push, refresh } = vi.hoisted(() => ({ signIn: vi.fn(), push: vi.fn(), refresh: vi.fn() }));
vi.mock('@convex-dev/auth/react', () => ({ useAuthActions: () => ({ signIn }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));
beforeEach(() => { vi.clearAllMocks(); signIn.mockResolvedValue({ signingIn: true }); });

it('allows signing in with a valid password whose length includes surrounding spaces', async () => {
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<LoginPage />); });
  try {
    await act(async () => {
      const inputs = tree.root.findAllByType('input');
      inputs[0].props.onChange({ target: { value: 'member@example.com' } });
      inputs[1].props.onChange({ target: { value: '  Ab1   ' } });
    });
    expect(tree.root.findByProps({ type: 'submit' }).props.disabled).toBe(false);
    await act(async () => tree.root.findByType('form').props.onSubmit({ preventDefault() {} }));
    expect(signIn).toHaveBeenCalledWith('password', { flow: 'signIn', email: 'member@example.com', password: '  Ab1   ' });
  } finally { await act(async () => tree.unmount()); }
});
