import type { ReactNode } from 'react';
export const useSearchParams = () => new URLSearchParams(window.location.search);
export const usePortalRole = () => new URLSearchParams(window.location.search).get('role') || 'enrollment';
const toast = (message: string) => { (window as unknown as { __toasts: string[] }).__toasts.push(message); };
export const useToast = () => ({ toast });
export default function Link({ children, href, ...props }: { children: ReactNode; href: string; [key: string]: unknown }) {
  const role = new URLSearchParams(window.location.search).get('role');
  const target = new URL(href, window.location.origin);
  if (role) target.searchParams.set('role', role);
  return <a {...props} href={`${target.pathname}${target.search}`}>{children}</a>;
}
