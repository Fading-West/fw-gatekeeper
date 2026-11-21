import type { ReactNode } from 'react';
export const usePortalRole = () => 'admin';
const router = { replace: () => {} };
export const useRouter = () => router;
export const useSearchParams = () => new URLSearchParams();
export default function Link({ children, ...props }: { children: ReactNode; href: string; className?: string }) {
  return <a {...props}>{children}</a>;
}
