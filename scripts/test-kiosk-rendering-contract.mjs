import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({});
vm.runInContext(readFileSync(new URL('../pi-kiosk/static/rendering.js', import.meta.url), 'utf8'), context);
const renderer = context.KioskRendering;
const attack = '<img src=x onerror="alert(1)">';
const escaped = '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;';
const roster = renderer.roster({
    worker_count: attack, total_photos: attack,
    workers: [{ name: attack, employee_id: attack, photo_count: attack }],
});
assert.equal(roster.includes('<img'), false, 'Roster fields must never introduce executable tags');
assert.equal(roster.split(escaped).length - 1, 5, 'All five roster label/count positions escape untrusted values');
const log = renderer.attendance([{ worker_name: attack, timestamp: attack, action: 'clock_in" onclick="alert(1)' }]);
assert.equal(log.includes('<img'), false, 'Names and invalid timestamps remain escaped text');
assert.equal(log.includes('onclick='), false, 'Action values cannot inject attributes');
assert.equal(log.split(escaped).length - 1, 2);
const normal = renderer.roster({ workers: [{ name: "O'Brien & Sons", employee_id: 'FW-1', photo_count: 2 }] });
assert.ok(normal.includes('O&#39;Brien &amp; Sons'));
assert.ok(normal.includes('ID: FW-1'));
assert.ok(renderer.attendance([{ worker_name: 'Alex', timestamp: '2026-09-01T08:00:00', action: 'clock_in' }]).includes('class="pill clock_in"'));
const template = readFileSync(new URL('../pi-kiosk/templates/index.html', import.meta.url), 'utf8');
assert.ok(template.includes('KioskRendering.roster(admin)'));
assert.ok(template.includes('KioskRendering.attendance(logs)'));
console.log('Kiosk roster and attendance rendering safely escape untrusted worker data.');
