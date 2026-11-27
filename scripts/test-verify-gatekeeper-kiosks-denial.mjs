import assert from 'node:assert/strict';
import { kiosksPageAccessMatches } from '../.agents/skills/verify-gatekeeper/lib/feature.mjs';

const appUrl = 'http://127.0.0.1:43210';
assert.equal(kiosksPageAccessMatches('admin', 200, undefined, appUrl), true);
assert.equal(kiosksPageAccessMatches('admin', 307, appUrl + '/', appUrl), false);
for (const role of ['enrollment', 'viewer']) {
  assert.equal(kiosksPageAccessMatches(role, 307, appUrl + '/', appUrl), true);
  assert.equal(kiosksPageAccessMatches(role, 500, undefined, appUrl), false, 'A server error does not prove role denial');
  assert.equal(kiosksPageAccessMatches(role, 404, undefined, appUrl), false);
  assert.equal(kiosksPageAccessMatches(role, 200, undefined, appUrl), false);
  assert.equal(kiosksPageAccessMatches(role, 307, appUrl + '/login', appUrl), false);
  assert.equal(kiosksPageAccessMatches(role, 307, 'http://127.0.0.1:43211/', appUrl), false);
}
console.log('Verifier distinguishes restricted Kiosks redirects from failed requests');
