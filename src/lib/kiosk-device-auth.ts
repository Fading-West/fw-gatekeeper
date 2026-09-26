import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { hasDeviceKeyFormat, hasValidKioskKey, presentedKioskKey } from './auth';
import { lookupKioskCredential } from './convex-ingest';

export type KioskIdentity = { documentId: string; kioskId: string; aliases: string[] };

export function kioskClaims(value: Record<string, unknown>): unknown[] {
  return ['kiosk_id', 'kioskId'].filter(key => Object.prototype.hasOwnProperty.call(value, key)).map(key => value[key]);
}

// Use only after authenticateKiosk has checked every supplied claim. Keeping
// the submitted alias preserves deduplication keys for retries of old rows.
export function kioskEvidenceId(identity: Pick<KioskIdentity, 'kioskId'>, record: Record<string, unknown>, batch?: Record<string, unknown>): string {
  const claim = record.kiosk_id ?? record.kioskId ?? batch?.kiosk_id ?? batch?.kioskId;
  return typeof claim === 'string' ? claim.trim() : identity.kioskId;
}

export async function authenticateKiosk(req: NextRequest, claims: unknown[]): Promise<KioskIdentity | null> {
  let identity: KioskIdentity | null = null;
  if (hasDeviceKeyFormat(req)) {
    const hash = createHash('sha256').update(presentedKioskKey(req)!).digest('hex');
    identity = await lookupKioskCredential({ mode: 'device', credentialHash: hash });
  } else if (hasValidKioskKey(req)) {
    const identifier = claims.find((claim): claim is string => typeof claim === 'string' && !!claim.trim());
    if (!identifier) return null;
    identity = await lookupKioskCredential({ mode: 'legacy', identifier });
  }
  if (!identity) return null;
  const aliases = new Set(identity.aliases.map(alias => alias.trim().toLowerCase()));
  if (claims.some(claim => typeof claim !== 'string' || !aliases.has(claim.trim().toLowerCase()))) return null;
  return identity;
}
