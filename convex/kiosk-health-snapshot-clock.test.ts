import { afterEach, expect, it, vi } from 'vitest';
import http from './http';

// Run the registered action with a snapshot arriving after its request began.
const action = http.lookup('/api/public/kiosk-health', 'GET')![0] as unknown as {
  _handler: (ctx: { runQuery: () => Promise<unknown[]> }, request: Request) => Promise<Response>;
};
afterEach(() => vi.useRealTimers());

it('evaluates sync and device health against a clock sampled after the snapshot', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const startedAt = Date.parse('2026-10-08T12:00:00Z');
  vi.setSystemTime(startedAt);
  const lastSync = new Date(startedAt + 1000).toISOString();
  const response = await action._handler({
    runQuery: async () => {
      vi.setSystemTime(startedAt + 2000);
      return [{ last_sync: lastSync, health: {
        camera_ok: true, model_ok: true, reported_at: lastSync,
      } }];
    },
  }, new Request('https://synthetic.test/api/public/kiosk-health'));
  expect(await response.json()).toMatchObject({
    status: 'healthy', timestamp: new Date(startedAt + 2000).toISOString(),
    kiosks: { online: 1, offline: 0, stale_device_health: 0 },
  });
});
