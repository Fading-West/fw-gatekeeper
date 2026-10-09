import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const template = readFileSync(new URL('../pi-kiosk/templates/index.html', import.meta.url), 'utf8');
const start = template.indexOf('        async function toggleSupervisorControls()');
const end = template.indexOf('        async function fetchStatus()', start);
assert.ok(start >= 0 && end > start);
let calls = [];
let outcome = false;
let unlockResponse;
const context = vm.createContext({
    AbortController,
    adminVisible: true, supervisorStateVersion: 0, supervisorUnlock: {}, supervisorSubmit: {},
    supervisorBootNonce: 'a'.repeat(32),
    supervisorPin: { value: 'synthetic', select() {} }, supervisorError: {},
    supervisorDialog: { close() {} }, crypto: { randomUUID() { return 'synthetic-operation'; } },
    setAdminVisible(visible) { if (context.adminVisible !== visible) context.supervisorStateVersion += 1; context.adminVisible = visible; },
    openSupervisorDialog() { throw new Error('Must finish lock before unlocking'); },
    fetchStatus() {}, fetchLog() {},
    async fetch(url, options) {
        calls.push({ url, body: JSON.parse(options.body), signal: options.signal });
        if (url === '/supervisor/unlock') return new Promise(resolve => { unlockResponse = resolve; });
        return { ok: outcome };
    },
});
vm.runInContext('let supervisorLockPending = false; let supervisorLockNeeded = false; let supervisorUnlockPending = false; let supervisorUnlockGeneration = 0; let activeUnlockRequest = null; let activeUnlockController = null;\n' + template.slice(start, end), context);
await context.toggleSupervisorControls();
assert.equal(context.adminVisible, false);
assert.match(context.supervisorUnlock.textContent, /Retry locking/);
outcome = true;
await context.toggleSupervisorControls();
assert.equal(calls.length, 2);
assert.equal(context.supervisorUnlock.disabled, false);
assert.equal(context.supervisorUnlock.textContent, 'Supervisor controls (A)');
calls = [];
const pending = context.unlockSupervisorControls();
await context.unlockSupervisorControls();
assert.equal(calls.length, 1, 'double submission sends one unlock request');
assert.equal(calls[0].body.boot_nonce, 'a'.repeat(32));
assert.equal(context.supervisorSubmit.disabled, true);
context.cancelSupervisorUnlock();
await Promise.resolve();
assert.equal(calls.length, 2);
assert.equal(calls[1].body.request_id, calls[0].body.request_id);
unlockResponse({ ok: true });
await pending;
assert.equal(context.adminVisible, false, 'late successful unlock never reveals controls after cancellation');
assert.equal(context.supervisorSubmit.disabled, false);
calls = [];
context.crypto = {};
await context.unlockSupervisorControls();
assert.equal(calls.length, 0, 'missing secure randomness sends nothing');
assert.equal(context.supervisorSubmit.disabled, false);
assert.match(context.supervisorError.textContent, /Secure unlock identity unavailable/);
context.crypto = { randomUUID() { throw new Error('synthetic unsupported UUID'); } };
await context.unlockSupervisorControls();
assert.equal(calls.length, 0, 'throwing UUID generation releases the guard');
context.crypto = { getRandomValues(bytes) { bytes.fill(7); return bytes; } };
const fallback = context.unlockSupervisorControls();
await context.unlockSupervisorControls();
assert.equal(calls.length, 1, 'cryptographic fallback retains single flight');
assert.match(calls[0].body.request_id, /^[a-f0-9]{32}$/);
context.cancelSupervisorUnlock();
await Promise.resolve();
unlockResponse({ ok: true });
await fallback;
assert.equal(context.adminVisible, false, 'fallback identities retain cancellation revocation');
assert.equal(context.supervisorSubmit.disabled, false);

// Fetch deliberately ignores abort: a non-cooperative old response may still
// arrive after a confirmed lock and a new explicit unlock operation.
let operationNumber = 0;
context.crypto = { randomUUID() { return `synthetic-recovery-${++operationNumber}`; } };
let dialogOpens = 0;
context.openSupervisorDialog = () => { dialogOpens += 1; };
for (const lateTiming of ['while-new-pending', 'after-new-success']) {
    if (context.adminVisible) await context.toggleSupervisorControls();
    calls = [];
    const unresolvedOld = context.unlockSupervisorControls();
    const oldSuccess = unlockResponse;
    const oldCall = calls[0];
    outcome = false;
    context.cancelSupervisorUnlock();
    await Promise.resolve();
    assert.equal(oldCall.signal.aborted, false, 'Unconfirmed locking must not retire the operation');
    await context.unlockSupervisorControls();
    assert.equal(calls.length, 2, 'Fresh unlock stays blocked until server lock confirmation');
    outcome = true;
    await context.toggleSupervisorControls();
    assert.equal(calls[2].body.request_id, oldCall.body.request_id, 'Lock retry retains the old operation identity');
    assert.equal(oldCall.signal.aborted, true, 'Confirmed server lock aborts the retired request');
    assert.equal(context.supervisorSubmit.disabled, false, 'Confirmed lock releases the hung submit guard');
    const beforeDialog = dialogOpens;
    await context.toggleSupervisorControls();
    assert.equal(dialogOpens, beforeDialog + 1, 'Fresh explicit dialog opens before the old response settles');
    const fresh = context.unlockSupervisorControls();
    const freshSuccess = unlockResponse;
    const freshCall = calls[3];
    assert.notEqual(freshCall.body.request_id, oldCall.body.request_id);
    if (lateTiming === 'while-new-pending') {
        oldSuccess({ ok: true });
        await unresolvedOld;
        assert.equal(context.adminVisible, false, 'Retired success cannot reveal supervisor controls');
        assert.equal(context.supervisorSubmit.disabled, true, 'Retired finally cannot release a newer submit guard');
        assert.equal(vm.runInContext('supervisorUnlockPending', context), true);
        assert.equal(freshCall.signal.aborted, false);
        await context.unlockSupervisorControls();
        assert.equal(calls.length, 4, 'A stale finally cannot permit a second current unlock');
    }
    freshSuccess({ ok: true });
    await fresh;
    assert.equal(context.adminVisible, true, 'Fresh explicit unlock succeeds without waiting for the retired response');
    if (lateTiming === 'after-new-success') {
        oldSuccess({ ok: true });
        await unresolvedOld;
    }
    assert.equal(context.adminVisible, true);
    assert.equal(context.supervisorSubmit.disabled, false);
    assert.equal(vm.runInContext('activeUnlockRequest', context), freshCall.body.request_id,
        'Late retired success preserves the newer session operation owner');
}
console.log('Supervisor unlock is single flight; confirmed lock retires hung requests and fences late callbacks.');
