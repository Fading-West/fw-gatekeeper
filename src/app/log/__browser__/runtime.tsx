import type { ReactNode } from 'react';

export const useSearchParams = () => new URLSearchParams('date=2026-09-14');
export const usePortalRole = () => 'admin';
const toast = () => {};
export const useToast = () => ({ toast });
export default function Link({ children, href }: { children: ReactNode; href: string }) {
  return <a href={href}>{children}</a>;
}
