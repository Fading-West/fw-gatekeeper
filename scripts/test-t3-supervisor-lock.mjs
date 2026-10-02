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
    adminVisible: true, supervisorStateVersion: 0, supervisorUnlock: {}, supervisorSubmit: {},
    supervisorPin: { value: 'synthetic', select() {} }, supervisorError: {},
    supervisorDialog: { close() {} }, crypto: { randomUUID() { return 'synthetic-operation'; } },
    setAdminVisible(visible) { if (context.adminVisible !== visible) context.supervisorStateVersion += 1; context.adminVisible = visible; },
    openSupervisorDialog() { throw new Error('Must finish lock before unlocking'); },
    fetchStatus() {},
    async fetch(url, options) {
        calls.push({ url, body: JSON.parse(options.body) });
        if (url === '/supervisor/unlock') return new Promise(resolve => { unlockResponse = resolve; });
        return { ok: outcome };
    },
});
vm.runInContext('let supervisorLockPending = false; let supervisorLockNeeded = false; let supervisorUnlockPending = false; let activeUnlockRequest = null;\n' + template.slice(start, end), context);
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
console.log('Supervisor unlock is single flight and cancelled operations stay locked.');
