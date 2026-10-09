import { expect, it } from 'vitest';
import { getKioskSyncStatus, ONLINE_THRESHOLD_MS, STALE_THRESHOLD_MS } from './kiosk-sync-status';

const now = Date.parse('2026-10-08T12:00:00Z');
it.each([
  [0, 'online'], [ONLINE_THRESHOLD_MS, 'online'],
  [ONLINE_THRESHOLD_MS + 1, 'stale'], [STALE_THRESHOLD_MS, 'stale'],
  [STALE_THRESHOLD_MS + 1, 'offline'], [-1, 'offline'],
] as const)('classifies a sync age of %i ms as %s', (age, expected) => {
  expect(getKioskSyncStatus(new Date(now - age).toISOString(), now)).toBe(expected);
});
it('distinguishes missing sync history from an untrusted clock', () => {
  expect(getKioskSyncStatus(null, now)).toBe('never_synced');
  expect(getKioskSyncStatus(undefined, now)).toBe('never_synced');
  expect(getKioskSyncStatus('invalid', now)).toBe('offline');
});
