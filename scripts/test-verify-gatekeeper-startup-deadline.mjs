import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { CheckFailure, waitFor } from '../.agents/skills/verify-gatekeeper/lib/common.mjs';

// Model a local server that accepts the request but never completes its body.
let aborted = false;
let attempts = 0;
const watchdog = new AbortController();
try {
  await assert.rejects(Promise.race([
    waitFor('owned Next app health', async (signal) => {
      attempts += 1;
      signal?.addEventListener('abort', () => { aborted = true; }, { once: true });
      await delay(1000, undefined, { signal });
      return true;
    }, { timeoutMs: 30 }),
    delay(500, undefined, { signal: watchdog.signal }).then(() => {
      throw new Error('Verifier did not stop waiting for the in-flight probe');
    }),
  ]), (error) => error instanceof CheckFailure && /Timed out waiting for owned Next app health/.test(error.message));
  assert.equal(attempts, 1);
  assert.equal(aborted, true);
} finally {
  watchdog.abort();
}

let retries = 0;
assert.equal(await waitFor('recovering probe', async () => {
  if (++retries === 1) throw new Error('Connection refused');
  return 'ready';
}, { timeoutMs: 1000, intervalMs: 1 }), 'ready');
assert.equal(retries, 2);

await assert.rejects(waitFor('unavailable probe', async () => {
  throw new Error('Connection refused');
}, { timeoutMs: 30, intervalMs: 1 }), /Timed out waiting for unavailable probe: Connection refused/);
console.log('Gatekeeper verifier startup deadline passed');
