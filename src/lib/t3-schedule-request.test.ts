import { afterEach, expect, it, vi } from 'vitest';
import { acknowledgeScheduleRequest, scheduleRequestId } from './schedule-request';
afterEach(() => vi.unstubAllGlobals());
it('keeps an uncertain request for retry and allocates a new intent after acknowledgement', () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  const payload = { name: 'Synthetic', days: [1], start_time: '06:00', end_time: '14:30' };
  const first = scheduleRequestId(payload);
  expect(scheduleRequestId(payload)).toBe(first);
  expect(storage.size).toBe(1);
  acknowledgeScheduleRequest(payload);
  expect(storage.size).toBe(0);
  expect(scheduleRequestId(payload)).not.toBe(first);
  acknowledgeScheduleRequest(payload);
});
