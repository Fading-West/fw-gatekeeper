// Run each file in a separate process: Python services have overlapping module names.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const files = ["scripts"].flatMap(directory =>
  readdirSync(directory).filter(name => name.startsWith('test-') && name.endsWith('.mjs'))
    .sort().map(name => `${directory}/${name}`),
);
if (!files.length) throw new Error('No contract tests discovered');
for (const file of files) {
  console.log(`Running ${file}`);
  const result = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--experimental-strip-types', file], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Passed ${files.length} contract test files`);
