import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const template = readFileSync(new URL('../pi-kiosk/templates/index.html', import.meta.url), 'utf8');
const start = template.indexOf('        async function submitManualClock()');
const end = template.indexOf('        supervisorUnlock.addEventListener', start);
assert.ok(start >= 0 && end > start);
const requests = [];
let outcome = 'lost';
let release;
const context = vm.createContext({
    crypto: { randomUUID: () => 'synthetic-operation' },
    manualName: { value: '1' }, manualBtn: {}, manualResult: { style: {} },
    adminVisible: true, supervisorStateVersion: 0,
    fetchLog() {}, setAdminVisible() {}, openSupervisorDialog() {},
    fetch: async (_url, options) => {
        requests.push(JSON.parse(options.body));
        if (outcome === 'lost') throw new Error('synthetic response lost');
        if (outcome === 'deferred') await new Promise(resolve => { release = resolve; });
        return { ok: true, json: async () => ({ success: true, worker_name: 'Synthetic', action: 'clock_in' }) };
    },
});
vm.runInContext('let manualSubmitting = false; let pendingManualRequest = null;\n' + template.slice(start, end), context);
await context.submitManualClock();
assert.equal(context.manualName.disabled, true, 'Unknown outcome keeps original selection for replay');
context.manualName.value = ''; // A roster refresh removed the selected worker while the response was lost.
outcome = 'deferred';
const pending = context.submitManualClock();
await context.submitManualClock();
assert.equal(requests.length, 2, 'Double tap does not send another request');
assert.deepEqual(requests[0], requests[1], 'Lost response retries same operation identity');
release();
await pending;
assert.equal(context.manualName.disabled, false);
assert.equal(context.manualName.value, '');
console.log('Manual submission survives lost responses and suppresses simultaneous repeats.');
