import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const template = readFileSync(new URL('../pi-kiosk/templates/index.html', import.meta.url), 'utf8');
const start = template.indexOf('        async function toggleSupervisorControls()');
const end = template.indexOf('        async function unlockSupervisorControls()', start);
assert.ok(start >= 0 && end > start);
let calls = 0;
let outcome = false;
const context = vm.createContext({
    adminVisible: true, supervisorUnlock: {},
    setAdminVisible(visible) { context.adminVisible = visible; },
    openSupervisorDialog() { throw new Error('Must finish lock before unlocking'); },
    async fetch() { calls += 1; return { ok: outcome }; },
});
vm.runInContext('let supervisorLockPending = false; let supervisorLockNeeded = false;\n' + template.slice(start, end), context);
await context.toggleSupervisorControls();
assert.equal(context.adminVisible, false);
assert.match(context.supervisorUnlock.textContent, /Retry locking/);
outcome = true;
await context.toggleSupervisorControls();
assert.equal(calls, 2);
assert.equal(context.supervisorUnlock.disabled, false);
assert.equal(context.supervisorUnlock.textContent, 'Supervisor controls (A)');
console.log('Supervisor controls hide immediately and failed locking can be retried.');
