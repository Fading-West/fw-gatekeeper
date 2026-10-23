import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const blueprint = readFileSync('render.yaml', 'utf8');
const services = blueprint.split(/^  - type:/m).slice(1);
const portal = services.find(service => /^    name: fw-gatekeeper$/m.test(service));
const faceService = services.find(service => /^    name: fw-face-service$/m.test(service));

assert.ok(portal, 'The portal must be declared in the Blueprint');
assert.ok(faceService, 'The face service must be declared in the Blueprint');
assert.match(portal, /^    buildCommand: npm ci --include=dev && npm run build$/m,
  'Production builds must explicitly install build-time devDependencies');
for (const service of [portal, faceService]) {
  assert.match(service, /^    autoDeployTrigger: checksPass$/m,
    'Both services must wait for CI checks before automatically deploying');
  assert.doesNotMatch(service, /^    autoDeploy:/m,
    'Use Render\'s current autoDeployTrigger setting instead of the deprecated autoDeploy field');
}

console.log('Render Blueprint build and deploy contract passed');
