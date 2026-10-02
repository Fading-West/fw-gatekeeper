import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const template = readFileSync(new URL('../pi-kiosk/templates/index.html', import.meta.url), 'utf8');
const start = template.indexOf('        async function submitManualClock()');
const end = template.indexOf('        supervisorUnlock.addEventListener', start);
assert.ok(start >= 0 && end > start);
const requests = [];
const savedIntents = new Map();
const localStorage = {
    getItem: key => savedIntents.get(key) ?? null,
    setItem: (key, value) => savedIntents.set(key, value),
    removeItem: key => savedIntents.delete(key),
};
let outcome = 'lost';
let release;
const context = vm.createContext({
    crypto: { randomUUID: () => 'synthetic-operation' }, localStorage,
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
const intentStart = template.indexOf('        let manualSubmitting = false;');
const intentEnd = template.indexOf('        function tickClock()', intentStart);
const production = template.slice(intentStart, intentEnd) + template.slice(start, end);
vm.runInContext(production, context);
await context.submitManualClock();
assert.equal(context.manualName.disabled, true, 'Unknown outcome keeps original selection for replay');
assert.equal(savedIntents.size, 1, 'Intent was saved before the uncertain HTTP operation');
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
assert.equal(savedIntents.size, 0, 'Acknowledged receipt clears durable intent');

// A new page context replays the saved identity, even if the roster no longer has it.
outcome = 'lost';
context.manualName.value = '1';
await context.submitManualClock();
const reloaded = vm.createContext({ ...context, manualName: { value: '' }, manualBtn: {}, manualResult: { style: {} } });
vm.runInContext(production, reloaded);
outcome = 'success';
await reloaded.submitManualClock();
assert.deepEqual(requests.at(-1), requests.at(-2), 'Reload retries the same durable operation');
assert.equal(savedIntents.size, 0);

const before = requests.length;
const blocked = vm.createContext({ ...context, localStorage: { getItem() { return null; }, setItem() { throw new Error('quota'); } },
    manualName: { value: '1' }, manualBtn: {}, manualResult: { style: {} } });
vm.runInContext(production, blocked);
await blocked.submitManualClock();
assert.equal(requests.length, before, 'Storage failure prevents any attendance request');
console.log('Manual submission survives lost responses and suppresses simultaneous repeats.');
