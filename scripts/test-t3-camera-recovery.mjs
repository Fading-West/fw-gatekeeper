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
    Date, adminVisible: false, supervisorStateVersion: 0,
    document: { querySelector: () => image },
    async fetch() { return { json: async () => ({ state: 'ERROR', health: { camera_ok: cameraOkay } }) }; },
    statusMessageFromState: () => 'Synthetic status', applyStatusState() {},
});
for (const name of ['statusText', 'stateValue', 'workerIdValue', 'earValue', 'knownValue', 'liveValue', 'lastUpdated', 'livenessNote', 'syncChip']) context[name] = { style: {} };
vm.runInContext(template.slice(start, end), context);
await context.fetchStatus();
assert.equal(image.style.visibility, 'hidden', 'Camera fault hides the retained browser frame');
cameraOkay = true;
await context.fetchStatus();
assert.equal(image.style.visibility, 'visible');
console.log('Kiosk camera feed is hidden while capture is unavailable and restored after recovery.');
