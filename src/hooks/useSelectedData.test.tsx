import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { useSelectedData } from './useSelectedData';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('selected data request ownership', () => {
  it('hides old data immediately, ignores late responses, and prevents old mutation refreshes', async () => {
    const first = deferred<string>(); const second = deferred<string>();
    const loads = { A: vi.fn(() => first.promise), B: vi.fn(() => second.promise) };
    let latest!: ReturnType<typeof useSelectedData<string>>;
    function Probe({ selection }: { selection: 'A' | 'B' }) {
      latest = useSelectedData(selection, loads[selection]);
      return <span>{latest.data || (latest.loading ? 'loading' : latest.error)}</span>;
    }
    let tree!: ReactTestRenderer;
    await act(async () => { tree = create(<Probe selection="A" />); });
    const oldRefresh = latest.refresh;
    await act(async () => { tree.update(<Probe selection="B" />); });
    expect(latest.data).toBe(null);
    expect(latest.loading).toBe(true);
    await act(async () => second.resolve('B result'));
    expect(latest.data).toBe('B result');
    await act(async () => first.resolve('A late result'));
    expect(latest.data).toBe('B result');
    await act(async () => oldRefresh());
    expect(loads.A).toHaveBeenCalledOnce();
    expect(latest.data).toBe('B result');
    await act(async () => tree.unmount());
  });

  it('does not expose a previous successful payload after a refresh failure', async () => {
    const load = vi.fn().mockResolvedValueOnce('confirmed').mockRejectedValueOnce(new Error('offline'));
    let latest!: ReturnType<typeof useSelectedData<string>>;
    function Probe() { latest = useSelectedData('A', load); return null; }
    let tree!: ReactTestRenderer;
    await act(async () => { tree = create(<Probe />); });
    expect(latest.data).toBe('confirmed');
    await act(async () => latest.refresh());
    expect(latest.data).toBeNull();
    expect(latest.error).toBe('offline');
    await act(async () => tree.unmount());
  });
});
