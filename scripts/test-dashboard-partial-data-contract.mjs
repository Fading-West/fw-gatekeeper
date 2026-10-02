import fs from 'node:fs';
import assert from 'node:assert/strict';

const root = new URL('../', import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), 'utf8');

const dashboard = read('src/app/page.tsx');
assert.match(dashboard, /Promise\.allSettled/, 'Dashboard should fetch live signals independently');
assert.match(dashboard, /SignalFailure/, 'Dashboard should model individual signal failures');
assert.match(dashboard, /Live data gaps/, 'Dashboard should show a visible partial-data warning');
assert.match(dashboard, /Partial live data/, 'Dashboard live indicator should call out partial data');
assert.match(dashboard, /signalFreshness/, 'Dashboard should track freshness for each live signal');
assert.match(dashboard, /Refresh attempted/, 'Dashboard should not imply a partial refresh made every slice fresh');
assert.match(dashboard, /item\.freshnessLabel/, 'Dashboard Sentinel cards should visibly flag stale source data with source-aware badges');
assert.match(dashboard, /System health cached/, 'Dashboard readiness should visibly flag cached system health');
assert.match(dashboard, /Attendance status cached/, 'Dashboard worker statuses should visibly flag cached attendance');
assert.match(dashboard, /buildProactiveActions\(\{\s*date:\s*actionDate,/, 'Dashboard Action Center should pass the local action date into proactive links');
assert.match(dashboard, /\/exceptions\?date=\$\{today\}&status=open/, 'Dashboard signal failures should deep-link to the dated open exception queue');
assert.match(dashboard, /\/closeout\?date=\$\{today\}/, 'Dashboard signal failures should deep-link to the dated closeout view');
assert.match(dashboard, /\/log\?date=\$\{actionDate\}/, 'Dashboard attendance links should preserve the local action date');
assert.match(dashboard, /Worker roster unavailable/, 'Dashboard should not label a failed roster fetch as an empty worker list');
assert.match(dashboard, /signalFailures\.map/, 'Dashboard failures should become operator-visible action items or links');
assert.match(read('src/components/WorkerCard.tsx'), /Cached/, 'Worker cards should have a compact stale-data marker');

assert.match(dashboard, /fetchData\(true, false\)/, 'Automatic polling should coalesce active same-day reads');
assert.match(dashboard, /boundedRead/, 'Every live signal needs a bounded response read');
console.log('Dashboard partial-data contract passed');
