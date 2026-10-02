export type KioskSyncStatus = 'online' | 'stale' | 'offline' | 'never_synced';
export const ONLINE_THRESHOLD_MS = 15 * 60 * 1000;
export const STALE_THRESHOLD_MS = 60 * 60 * 1000;
export function getKioskSyncStatus(lastSync?: string | null, now = Date.now()): KioskSyncStatus {
  if (!lastSync) return 'never_synced';
  const age = now - Date.parse(lastSync);
  if (!Number.isFinite(age) || age < 0) return 'offline';
  if (age <= ONLINE_THRESHOLD_MS) return 'online';
  if (age <= STALE_THRESHOLD_MS) return 'stale';
  return 'offline';
}
