import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
it('retains failed request IDs across retries, close/reopen, edits, and reloads until acknowledged', async () => {
  const store = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => store.get(key) || null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  });
  let helper = await import('./correction-request');
  const original = { worker_id: 'worker', reason: 'Missed scan', corrected_timestamp: '2026-09-01T08:00:00' };
  const first = helper.correctionRequestId(original);
  expect(helper.correctionRequestId({ ...original })).toEqual(first);
  expect(helper.correctionRequestId({ ...original, reason: 'Changed evidence' })).not.toEqual(first);
  expect(helper.correctionRequestId({ ...original })).toEqual(first);
  vi.resetModules();
  helper = await import('./correction-request');
  expect(helper.correctionRequestId({ ...original })).toEqual(first);
  helper.acknowledgeCorrectionRequest(original);
  expect(helper.correctionRequestId(original)).not.toEqual(first);
});
it('retains retries in memory if session storage is unavailable', async () => {
  const helper = await import('./correction-request');
  const request = { reason: 'Storage disabled' };
  expect(helper.correctionRequestId(request)).toEqual(helper.correctionRequestId(request));
});
