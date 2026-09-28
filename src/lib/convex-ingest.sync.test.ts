import { afterEach, expect, it, vi } from 'vitest';
import { fetchWorkersForSync } from './convex-ingest';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('assembles every secured page and forwards the cursor without changing the kiosk response', async () => {
  vi.stubEnv('CONVEX_INGEST_URL', 'https://example.convex.site');
  vi.stubEnv('CONVEX_INGEST_KEY', 'test-ingest-key');
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ workers: [{ id: 'first' }], isDone: false, continueCursor: 'next' }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ workers: [{ id: 'last', active: 0 }], isDone: true, continueCursor: 'done' }) });
  vi.stubGlobal('fetch', fetchMock);

  expect(await fetchWorkersForSync('2026-09-01T00:00:00Z', true)).toEqual({
    workers: [{ id: 'first' }, { id: 'last', active: 0 }],
  });
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ since: '2026-09-01T00:00:00Z', inclusive: true });
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ since: '2026-09-01T00:00:00Z', inclusive: true, cursor: 'next' });
});

it('fails the whole roster when a later page fails', async () => {
  vi.stubEnv('CONVEX_INGEST_URL', 'https://example.convex.site');
  vi.stubEnv('CONVEX_INGEST_KEY', 'test-ingest-key');
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ workers: [{ id: 'first' }], isDone: false, continueCursor: 'next' }) })
    .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: 'Unavailable' }) }));
  await expect(fetchWorkersForSync('', true)).rejects.toThrow();
});
