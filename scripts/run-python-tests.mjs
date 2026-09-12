// Run each file in a separate process: Python services have overlapping module names.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const files = ["pi-kiosk", "face-service"].flatMap(directory =>
  readdirSync(directory).filter(name => name.startsWith('test_') && name.endsWith('.py'))
    .sort().map(name => `${directory}/${name}`),
);
if (!files.length) throw new Error('No python tests discovered');
for (const file of files) {
  console.log(`Running ${file}`);
  const result = spawnSync(process.env.PYTHON || 'python3', [file], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Passed ${files.length} python test files`);
