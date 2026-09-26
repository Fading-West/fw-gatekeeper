import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { hasDeviceKeyFormat, hasValidKioskKey, presentedKioskKey } from './auth';
import { lookupKioskCredential } from './convex-ingest';

export type KioskIdentity = { kioskId: string; aliases: string[] };

export function kioskClaims(value: Record<string, unknown>): unknown[] {
  return ['kiosk_id', 'kioskId'].filter(key => Object.hasOwn(value, key)).map(key => value[key]);
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
