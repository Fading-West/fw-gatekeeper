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
for (const readiness of [undefined, null]) {
    const context = vm.createContext({
        health: { sync_online: true, sync_auth_ok: readiness, last_sync_at: '2026-10-02T12:00:00' },
        rejected: 0, queued: 0, syncChip: { style: {} },
    });
    vm.runInContext(template.slice(start, end), context);
    assert.match(context.syncChip.textContent, /protected sync not fully confirmed/);
    assert.doesNotMatch(context.syncChip.textContent, /Connected|Synced/);
}
console.log('Protected authorization faults and unknown restart state remain truthful over public reachability.');
