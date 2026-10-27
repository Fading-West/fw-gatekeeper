import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const template = readFileSync(new URL('../pi-kiosk/templates/index.html', import.meta.url), 'utf8');
const start = template.indexOf('        async function fetchStatus()');
const end = template.indexOf('        function renderAdmin(', start);
assert.ok(start >= 0 && end > start);
const image = { style: {} };
let cameraOkay = false;
const context = vm.createContext({
    statusInFlight: false, supervisorBootNonce: null, clockWarning: { hidden: true },
    AbortController, setTimeout, clearTimeout, STATUS_TIMEOUT_MS: 1000,
    connection: { statusOk: () => ({}), statusFailed() {} },
    cameraFeed: {
        connected: true, connects: 0,
        isConnected() { return this.connected; },
        connect() { this.connected = true; this.connects += 1; },
        disconnect() { this.connected = false; image.style.visibility = 'hidden'; },
    },
    showReconnecting: () => assert.fail('Successful polling must not reconnect'),
    Date, adminVisible: false, supervisorStateVersion: 0,
    document: { getElementById: () => image },
    async fetch() { return { ok: true, json: async () => ({ state: 'ERROR', health: { camera_ok: cameraOkay } }) }; },
    statusMessageFromState: () => 'Synthetic status', applyStatusState() {},
});
for (const name of ['statusText', 'stateValue', 'workerIdValue', 'earValue', 'knownValue', 'liveValue', 'lastUpdated', 'livenessNote', 'syncChip']) context[name] = { style: {} };
vm.runInContext(template.slice(start, end), context);
await context.fetchStatus();
assert.equal(image.style.visibility, 'hidden', 'Camera fault hides the retained browser frame');
assert.equal(context.cameraFeed.connected, false, 'Camera fault drops the stream');
await context.fetchStatus();
assert.equal(context.cameraFeed.connects, 0, 'No reconnect while capture is unavailable');
cameraOkay = true;
await context.fetchStatus();
assert.equal(context.cameraFeed.connects, 1, 'Recovery starts a fresh stream instead of keeping the ended one');
console.log('Kiosk camera feed is hidden while capture is unavailable and restored after recovery.');
