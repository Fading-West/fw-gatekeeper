import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { useSelectedData } from './useSelectedData';

let tree: ReactTestRenderer | undefined;
afterEach(async () => {
  if (tree) await act(async () => tree!.unmount());
  tree = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(['request', 'body'])('releases a stalled %s read, aborts it and permits a retry without accepting its late result', async (stage) => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let resolve!: (value: string) => void;
  const stalled = new Promise<string>((yes) => { resolve = yes; });
  let signal!: AbortSignal;
  const loader = vi.fn(async (active: AbortSignal) => {
    signal = active;
    if (stage === 'body') {
      const response = { json: () => stalled };
      await Promise.resolve(); // Headers arrived; decoding the body stalls.
      return response.json();
    }
    return stalled;
  });
  let latest!: ReturnType<typeof useSelectedData<string>>;
  function Probe() { latest = useSelectedData('selected-day', loader); return null; }
  await act(async () => { tree = create(<Probe />); });
  const stalledSignal = signal;
  expect(latest.loading).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(latest.loading).toBe(false);
  expect(latest.data).toBeNull();
  expect(latest.error).toContain('timed out');
  expect(stalledSignal.aborted).toBe(true);
  loader.mockResolvedValueOnce('fresh');
  await act(async () => { await latest.refresh(); });
  expect(latest.data).toBe('fresh');
  expect(latest.error).toBe('');
  await act(async () => { resolve('late stale data'); });
  expect(latest.data).toBe('fresh');
});
