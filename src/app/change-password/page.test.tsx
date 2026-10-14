import { act, create } from 'react-test-renderer';
import { ConvexError } from 'convex/values';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ChangePasswordPage from './page';

const { changePassword, signOut, replace, refresh } = vi.hoisted(() => ({
  changePassword: vi.fn(), signOut: vi.fn(), replace: vi.fn(), refresh: vi.fn(),
}));
vi.mock('convex/react', () => ({ useAction: () => changePassword }));
vi.mock('@convex-dev/auth/react', () => ({ useAuthActions: () => ({ signOut }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace, refresh }) }));
beforeEach(() => { vi.clearAllMocks(); changePassword.mockResolvedValue(null); signOut.mockResolvedValue(undefined); });
afterEach(() => vi.unstubAllGlobals());

async function form(confirmation = 'PrivatePass456!') {
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<ChangePasswordPage />); });
  const values = ['  TemporaryPass123!  ', 'PrivatePass456!', confirmation];
  await act(async () => {
    tree.root.findAllByType('input').forEach((input, index) => input.props.onChange({ target: { value: values[index] } }));
  });
  return tree;
}

it('checks confirmation before submitting and leaves the user on the form', async () => {
  const tree = await form('different');
  try {
    await act(async () => tree.root.findByType('form').props.onSubmit({ preventDefault() {} }));
    expect(changePassword).not.toHaveBeenCalled();
    expect(tree.root.findByProps({ role: 'alert' }).children).toEqual(['New passwords do not match.']);
  } finally { await act(async () => tree.unmount()); }
});

it('preserves password whitespace, clears browser auth, and returns to sign-in after success', async () => {
  const tree = await form();
  try {
    await act(async () => tree.root.findByType('form').props.onSubmit({ preventDefault() {} }));
    expect(changePassword).toHaveBeenCalledWith({ currentPassword: '  TemporaryPass123!  ', newPassword: 'PrivatePass456!' });
    expect(signOut).toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith('/login');
    expect(refresh).toHaveBeenCalled();
  } finally { await act(async () => tree.unmount()); }
});

it.each([
  ['INVALID_CURRENT_PASSWORD', 'Current password is incorrect.'],
  ['TOO_MANY_ATTEMPTS', 'Too many attempts. Try again later.'],
  ['PASSWORD_CHANGE_CONFLICT', 'Your account changed while the password was being updated. Try again.'],
  ['Unauthorized', 'Your session has ended. Sign out and sign in again.'],
  ['Choose a password different from your current password', 'Choose a password different from your current password'],
])('shows an actionable %s error without signing out', async (code, message) => {
  // Mirror the Convex client: message has a stack prefix, data is the server string.
  const error = new ConvexError(code);
  error.message = `[CONVEX A(portalMembers:changePassword)] [Request ID: 1] Server Error\nUncaught ConvexError: ${code}\n  Called by client`;
  changePassword.mockRejectedValue(error);
  const tree = await form();
  try {
    await act(async () => tree.root.findByType('form').props.onSubmit({ preventDefault() {} }));
    expect(tree.root.findByProps({ role: 'alert' }).children).toEqual([message]);
    expect(signOut).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  } finally { await act(async () => tree.unmount()); }
});
