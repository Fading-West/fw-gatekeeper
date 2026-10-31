import { getKioskSyncStatus } from './kiosk-sync-status';

export const ROSTER_CONFIRMATION_STALL_MS = 15 * 60 * 1000;

/** A retry proves the prior receipt was not confirmed; issuance alone does not. */
export function getRosterConfirmationStall(
  lastSync?: string | null,
  retriedAt?: string | null,
  now = Date.now(),
): boolean {
  const retryMs = retriedAt ? Date.parse(retriedAt) : NaN;
  return Number.isFinite(retryMs) && retryMs <= now &&
    now - retryMs > ROSTER_CONFIRMATION_STALL_MS &&
    getKioskSyncStatus(lastSync, now) === 'online';
}
