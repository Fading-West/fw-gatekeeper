import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const template = fs.readFileSync('pi-kiosk/templates/index.html', 'utf8');
const start = template.indexOf('async function fetchStatus()');
const end = template.indexOf('function renderAdmin(', start);
assert.ok(start >= 0 && end > start);
const element = () => ({ textContent: '', style: {} });
const context = vm.createContext({
  statusInFlight: false, supervisorBootNonce: null,
  AbortController, setTimeout, clearTimeout, STATUS_TIMEOUT_MS: 1000,
  connection: { statusOk: () => ({}), statusFailed() {} },
  cameraFeed: { isConnected: () => true, connect() {} },
  document: { getElementById: () => element() },
  showReconnecting: () => assert.fail('Successful status polling must not reconnect'),
  supervisorStateVersion: 0, adminVisible: false, clockWarning: { hidden: true },
  statusText: element(), stateValue: element(), workerIdValue: element(),
  earValue: element(), knownValue: element(), liveValue: element(),
  lastUpdated: element(), livenessNote: element(), syncChip: element(),
  statusMessageFromState: () => 'Attendance recorded', applyStatusState() {},
});
vm.runInContext(`${template.slice(start, end)}; globalThis.pollStatus = fetchStatus;`, context);
for (const [clockStatus, warningHidden] of [[false, false], [true, true], [null, true], [undefined, true], [false, false]]) {
  context.fetch = async () => ({ ok: true, json: async () => ({ health: { clock_synchronized: clockStatus } }) });
  await context.pollStatus();
  assert.equal(context.clockWarning.hidden, warningHidden);
  assert.equal(context.statusText.textContent, 'Attendance recorded');
  assert.equal(context.statusInFlight, false);
}
assert.match(template, /id="clockWarning"[^>]*role="alert"/);
assert.match(template, /Attendance times may be wrong/);
console.log('PASS: local clock warning appears, recovers, and stays hidden for unknown clocks');
