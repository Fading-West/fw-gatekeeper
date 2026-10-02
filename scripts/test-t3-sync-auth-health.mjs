import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const template = readFileSync(new URL('../pi-kiosk/templates/index.html', import.meta.url), 'utf8');
const start = template.indexOf('                if (health.sync_auth_ok === false)');
const end = template.indexOf('                if (requestSupervisorStateVersion', start);
assert.ok(start >= 0 && end > start);
for (const online of [true, false]) {
    const context = vm.createContext({
        health: { sync_online: online, sync_auth_ok: false, sync_auth_faults: ['attendance', 'roster_ack'] },
        rejected: 2, queued: 3, syncChip: { style: {} },
    });
    vm.runInContext(template.slice(start, end), context);
    assert.match(context.syncChip.textContent, /authorization needs attention/);
    assert.match(context.syncChip.textContent, /attendance upload, roster confirmation/);
    assert.match(context.syncChip.textContent, /3 retryable queued; 2 rejected/);
    assert.doesNotMatch(context.syncChip.textContent, /Connected|Synced/);
}
console.log('Protected authorization faults remain visible while public health is online or offline.');
