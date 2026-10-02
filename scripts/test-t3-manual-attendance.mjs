import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const template = readFileSync(new URL('../pi-kiosk/templates/index.html', import.meta.url), 'utf8');
const start = template.indexOf('        async function submitManualClock()');
const end = template.indexOf('        supervisorUnlock.addEventListener', start);
const intentStart = template.indexOf('        let manualSubmitting = false;');
const intentEnd = template.indexOf('        function tickClock()', intentStart);
assert.ok(start >= 0 && end > start && intentStart >= 0 && intentEnd > intentStart);
const production = template.slice(intentStart, intentEnd) + template.slice(start, end);
const intentKey = 'fw-gatekeeper-pending-manual-attendance-v1';
let nextOperation = 0;

function syntheticBackend() {
    const requests = [];
    const events = [];
    const receipts = new Map();
    const originStorage = new Map();
    return {
        requests, events, originStorage,
        async fetch(network, _url, options) {
            const operation = JSON.parse(options.body);
            requests.push(operation);
            let receipt = receipts.get(operation.request_id);
            if (!receipt) {
                const action = events.at(-1)?.action === 'clock_in' ? 'clock_out' : 'clock_in';
                receipt = { success: true, worker_name: 'Synthetic', action };
                receipts.set(operation.request_id, receipt);
                events.push({ ...operation, action });
            }
            // Commit precedes any lost response, as in the real receipt transaction.
            if (network.outcome === 'lost') throw new Error('synthetic response lost after commit');
            if (network.outcome === 'deferred') await new Promise(resolve => { network.release = resolve; });
            return { ok: true, status: 200, json: async () => receipt };
        },
    };
}

function page(backend, savedIntents = new Map(), storageOverrides = {}, selectedWorker = '1') {
    const network = { outcome: 'success' };
    const sessionStorage = {
        getItem: key => savedIntents.get(key) ?? null,
        setItem: (key, value) => savedIntents.set(key, value),
        removeItem: key => savedIntents.delete(key),
        ...storageOverrides,
    };
    const context = vm.createContext({
        crypto: { randomUUID: () => `synthetic-operation-${++nextOperation}` }, sessionStorage,
        localStorage: {
            getItem: key => backend.originStorage.get(key) ?? null,
            setItem: (key, value) => backend.originStorage.set(key, value),
            removeItem: key => backend.originStorage.delete(key),
        },
        manualName: { value: selectedWorker }, manualBtn: {}, manualResult: { style: {} },
        adminVisible: true, supervisorStateVersion: 0,
        fetchLog() {}, setAdminVisible() {}, openSupervisorDialog() {},
        fetch: (...args) => backend.fetch(network, ...args),
    });
    vm.runInContext(production, context);
    return { context, network, savedIntents };
}

const backend = syntheticBackend();
const original = page(backend);
original.network.outcome = 'lost';
await original.context.submitManualClock();
assert.equal(original.context.manualName.disabled, true, 'Unknown outcome keeps original selection for replay');
assert.equal(original.savedIntents.size, 1, 'Intent was saved before the uncertain HTTP operation');
original.context.manualName.value = ''; // Roster refresh removed the selected worker.
original.network.outcome = 'deferred';
const pending = original.context.submitManualClock();
await original.context.submitManualClock();
assert.equal(backend.requests.length, 2, 'Double tap does not send another request');
assert.deepEqual(backend.requests[0], backend.requests[1], 'Lost response retries same operation identity');
assert.equal(backend.events.length, 1, 'Uncertain response replay does not repeat the committed event');
original.network.release();
await pending;
assert.equal(original.context.manualName.disabled, false);
assert.equal(original.context.manualName.value, '');
assert.equal(original.savedIntents.size, 0, 'Acknowledged receipt clears this tab intent');

// Same-origin pages share a backend, but each owns its session storage.
const sharedBackend = syntheticBackend();
const tabAStorage = new Map();
const tabBStorage = new Map();
const tabA = page(sharedBackend, tabAStorage);
const tabB = page(sharedBackend, tabBStorage);
tabA.network.outcome = 'lost';
await tabA.context.submitManualClock();
const uncertainA = tabAStorage.get(intentKey);
await tabB.context.submitManualClock();
assert.equal(tabAStorage.get(intentKey), uncertainA, 'Successful tab B cannot erase tab A uncertain receipt');
assert.equal(tabBStorage.size, 0, 'Tab B clears only its own acknowledged receipt');
assert.notEqual(sharedBackend.requests[0].request_id, sharedBackend.requests[1].request_id);
assert.deepEqual(sharedBackend.events.map(event => event.action), ['clock_in', 'clock_out']);
const reloadedA = page(sharedBackend, tabAStorage, {}, '');
await reloadedA.context.submitManualClock();
assert.deepEqual(sharedBackend.requests[2], sharedBackend.requests[0], 'Reload A retries its original committed operation');
assert.equal(sharedBackend.events.length, 2, 'Reload A returns its receipt instead of committing a third event');
assert.equal(sharedBackend.events.at(-1).action, 'clock_out', 'Replay does not reverse the successful second action');
assert.match(reloadedA.context.manualResult.textContent, /clock in$/, 'A sees its original receipt, not the newer action');
assert.equal(tabAStorage.size, 0);

// A late receipt must not remove a different intent, even within the same tab.
const mismatched = page(sharedBackend);
mismatched.network.outcome = 'deferred';
const lateReceipt = mismatched.context.submitManualClock();
const replacement = JSON.stringify({ worker_id: 1, request_id: 'different-pending-operation' });
mismatched.savedIntents.set(intentKey, replacement);
mismatched.network.release();
await lateReceipt;
assert.equal(mismatched.savedIntents.get(intentKey), replacement, 'Cleanup is conditional on the acknowledged identity');
const beforeBlocked = sharedBackend.requests.length;
await mismatched.context.submitManualClock();
assert.equal(sharedBackend.requests.length, beforeBlocked, 'Changed retry storage blocks further HTTP');
assert.equal(mismatched.context.manualName.disabled, true);

for (const overrides of [
    { setItem() { throw new Error('quota'); } },
    { setItem() {} }, // A write that silently fails also cannot guarantee retry.
    { getItem() { throw new Error('storage denied'); } },
]) {
    const blocked = page(sharedBackend, new Map(), overrides);
    await blocked.context.submitManualClock();
    assert.equal(sharedBackend.requests.length, beforeBlocked, 'Unavailable storage prevents any attendance request');
}
const corrupt = page(sharedBackend, new Map([[intentKey, '{invalid-json']]));
await corrupt.context.submitManualClock();
assert.equal(sharedBackend.requests.length, beforeBlocked, 'Corrupt saved intent prevents HTTP');
const missingRetry = page(sharedBackend, new Map([[intentKey, uncertainA]]), {}, '');
missingRetry.savedIntents.clear();
await missingRetry.context.submitManualClock();
assert.equal(sharedBackend.requests.length, beforeBlocked, 'Missing saved retry identity prevents HTTP');
console.log('Manual receipt replay survives same-tab reload and independent tab actions without duplicate events.');
