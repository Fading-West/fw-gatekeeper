#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const config = read('pi-kiosk/config.py');
const exceptions = read('convex/shiftExceptions.ts');
const attemptsApi = read('src/app/api/recognition-attempts/route.ts');
const kioskDefault = config.match(/^RECOGNITION_MIN_MARGIN\s*=\s*([\d.]+)\s*$/m);
const serverThreshold = exceptions.match(/const LOW_MARGIN_THRESHOLD\s*=\s*([\d.]+);/);
assert.ok(kioskDefault, 'Kiosk minimum margin must have an explicit numeric default.');
assert.ok(serverThreshold, 'Server low-margin policy must have an explicit numeric threshold.');
assert.equal(Number(kioskDefault[1]), Number(serverThreshold[1]),
  'Kiosk minimum-margin default must stay aligned with the server low-margin policy.');
const apiThreshold = attemptsApi.match(/const LOW_MARGIN_THRESHOLD\s*=\s*([\d.]+);/);
assert.ok(apiThreshold, 'Recognition Lab must have an explicit low-margin threshold.');
assert.equal(Number(apiThreshold[1]), Number(serverThreshold[1]),
  'Recognition Lab low-margin summary must stay aligned with shift exceptions.');
// The kiosk's behavioral boundary tests require strict acceptance to complement
// this inclusive server review policy; changing either side needs both updated.
assert.match(exceptions, /scoreMargin\s*<=\s*LOW_MARGIN_THRESHOLD/);
assert.match(attemptsApi, /attempt\.margin\s*<=\s*LOW_MARGIN_THRESHOLD/);

// rejected_ambiguous is passed through unchanged; no schema enum needs updating.
assert.match(read('convex/recognitionAttempts.ts'), /decision:\s*v\.string\(\)/);
assert.match(read('convex/schema.ts'), /decision:\s*v\.string\(\)/);
assert.match(read('src/app/api/recognition-attempts/bulk/route.ts'),
  /decision:\s*optionalString\(raw\.decision\)\s*\|\|\s*'unknown'/);
console.log('Recognition margin contract passed');
