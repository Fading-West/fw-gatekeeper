import { expect, it } from 'vitest';
import { getRosterConfirmationStall, ROSTER_CONFIRMATION_STALL_MS } from './kiosk-roster-confirmation';

const now = Date.parse('2026-10-30T12:00:00Z');
const iso = (age: number) => new Date(now - age).toISOString();
it('requires an online kiosk and a valid first retry strictly older than 15 minutes', () => {
  expect(ROSTER_CONFIRMATION_STALL_MS).toBe(15 * 60_000);
  expect(getRosterConfirmationStall(iso(0), iso(15 * 60_000 + 1), now)).toBe(true);
  for (const retry of [null, undefined, '', 'invalid', iso(-1), iso(15 * 60_000), iso(0)]) {
    expect(getRosterConfirmationStall(iso(0), retry, now)).toBe(false);
  }
  for (const sync of [null, undefined, '', 'invalid', iso(-1), iso(15 * 60_000 + 1), iso(61 * 60_000)]) {
    expect(getRosterConfirmationStall(sync, iso(20 * 60_000), now)).toBe(false);
  }
  expect(getRosterConfirmationStall(iso(15 * 60_000), iso(20 * 60_000), now)).toBe(true);
});
