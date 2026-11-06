import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = fileURLToPath(new URL('./', import.meta.url));
const root = path.resolve(here, '../..');
const reference = path.join(root, 'build/reference');
const require = createRequire(path.join(reference, 'package.json'));
const config = require(path.join(reference, 'jest.config.js'));
const out = path.join(root, 'build/reference-performance-tests', String(Date.now()));
await mkdir(out, {recursive: true});
const evidence = {schemaVersion: 1, passed: false, platforms: [], limitations: ['Jest native primitives are mocked; actual shared workload and RNTester component graph/navigation execute. Native route delivery and real geometry require platform tests.', 'Only known deprecated-internal-import notices are allowed; Image.prefetch uses its real Promise-shaped contract without network I/O; density assets resolve as Metro does.']};
for (const platform of ['ios', 'android']) {
  const results = path.join(out, `${platform}.json`);
  const log = path.join(out, `${platform}.log`);
  const selectedConfig = {...config, rootDir: reference, resolver: path.join(here, 'jest-resolver.cjs'), haste: {...config.haste, defaultPlatform: platform}};
  const run = spawnSync(process.execPath, [require.resolve('jest/bin/jest'),
    'packages/rn-tester/js/__tests__/NativeHostPerformanceRoute-test.js', '--runInBand', '--watchman=false',
    '--config', JSON.stringify(selectedConfig), '--json', `--outputFile=${results}`],
  {cwd: reference, env: {...process.env, NH_REFERENCE_TEST_PLATFORM: platform}, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024});
  await writeFile(log, `${run.stdout || ''}\n${run.stderr || ''}`);
  let counts;
  try { const parsed = JSON.parse(await readFile(results, 'utf8')); counts = {passed: parsed.numPassedTests, failed: parsed.numFailedTests, skipped: parsed.numPendingTests}; } catch {}
  evidence.platforms.push({platform, exitCode: run.status, error: run.error?.message, counts, results, log});
}
evidence.passed = evidence.platforms.every(item => item.exitCode === 0 && item.counts?.passed === 4 && item.counts.failed === 0 && item.counts.skipped === 0);
const output = path.join(root, 'build/reference-performance-route-evidence.json');
await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
console.log(`${evidence.passed ? 'Passed' : 'Failed'} full RNTester route checks. Evidence: ${output}`);
if (!evidence.passed) process.exitCode = 1;
