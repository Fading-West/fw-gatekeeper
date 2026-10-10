#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const config = read('pi-kiosk/config.py');
const exceptions = read('convex/shiftExceptions.ts');
const kioskDefault = config.match(/^RECOGNITION_MIN_MARGIN\s*=\s*([\d.]+)\s*$/m);
const serverThreshold = exceptions.match(/const LOW_MARGIN_THRESHOLD\s*=\s*([\d.]+);/);
assert.ok(kioskDefault, 'Kiosk minimum margin must have an explicit numeric default.');
assert.ok(serverThreshold, 'Server low-margin policy must have an explicit numeric threshold.');
assert.equal(Number(kioskDefault[1]), Number(serverThreshold[1]),
  'Kiosk minimum-margin default must stay aligned with the server low-margin policy.');

// rejected_ambiguous is passed through unchanged; no schema enum needs updating.
assert.match(read('convex/recognitionAttempts.ts'), /decision:\s*v\.string\(\)/);
assert.match(read('convex/schema.ts'), /decision:\s*v\.string\(\)/);
assert.match(read('src/app/api/recognition-attempts/bulk/route.ts'),
  /decision:\s*optionalString\(raw\.decision\)\s*\|\|\s*'unknown'/);
console.log('Recognition margin contract passed');
