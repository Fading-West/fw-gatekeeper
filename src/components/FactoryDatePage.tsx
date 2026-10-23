'use client';

import { Suspense, useSyncExternalStore, type ReactNode } from 'react';

const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

/** Match the server during hydration, then initialise the factory clock on the client. */
export function FactoryDatePage({ children }: { children: ReactNode }) {
  const mounted = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  return <Suspense fallback={null}>{mounted ? children : null}</Suspense>;
}
