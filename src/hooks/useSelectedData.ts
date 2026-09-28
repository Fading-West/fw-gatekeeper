'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/** A response belongs to the selection that requested it, even if requests finish out of order. */
export function useSelectedData<T>(key: string, load: (signal: AbortSignal) => Promise<T>) {
  const [state, setState] = useState<{ key: string; value: T | null; error: string; loading: boolean }>({ key, value: null, error: '', loading: true });
  const selectedKey = useRef(key);
  selectedKey.current = key;
  const requestId = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    // A mutation started on an old selection may finish after navigation.
    if (selectedKey.current !== key) return;
    controller.current?.abort();
    const active = new AbortController();
    controller.current = active;
    const id = ++requestId.current;
    setState({ key, value: null, error: '', loading: true });
    try {
      const value = await load(active.signal);
      if (active.signal.aborted || id !== requestId.current || selectedKey.current !== key) return;
      setState({ key, value, error: '', loading: false });
    } catch (error) {
      if (active.signal.aborted || id !== requestId.current || selectedKey.current !== key) return;
      setState({ key, value: null, error: error instanceof Error ? error.message : 'Unable to load this selection', loading: false });
    }
  }, [key, load]);

  useEffect(() => {
    void refresh();
    return () => { controller.current?.abort(); requestId.current += 1; };
  }, [refresh]);

  const loading = state.key !== key || state.loading;
  return { data: loading ? null : state.value, loading, error: state.key === key ? state.error : '', refresh };
}
