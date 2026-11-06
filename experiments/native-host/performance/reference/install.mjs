import {readFile, writeFile, mkdir, copyFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = fileURLToPath(new URL('./', import.meta.url));
const prototype = path.resolve(here, '../..');
const reference = path.join(prototype, 'build/reference');
const js = path.join(reference, 'packages/rn-tester/js');
const revision = spawnSync('git', ['rev-parse', 'HEAD'], {cwd: reference, encoding: 'utf8'});
assert.equal(revision.status, 0, revision.stderr);
assert.equal(revision.stdout.trim(), 'fe398e511d7b4cfa22baf5b449e256ff9b7d66c4', 'Unexpected reference revision');
const moduleDir = path.join(js, 'examples/NativeHostPerformance');
const adapterOnly = process.argv.includes('--adapter-only');
await mkdir(moduleDir, {recursive: true});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const evidence = {schemaVersion: 1, referenceRevision: revision.stdout.trim(), moduleKey: 'NativeHostPerformanceExample',
  nativeRouteArgument: 'NativeHostPerformance', copiedFiles: {}, changedFiles: [], fullGraphRetained: true};
for (const name of ['workload.js', 'revision.js']) {
  const from = path.join(prototype, 'performance', name);
  const to = path.join(moduleDir, name);
  const before = await readFile(from);
  if (!adapterOnly) await copyFile(from, to);
  const actual = await readFile(to);
  if (name === 'workload.js' || !adapterOnly) assert.deepEqual(actual, before, `${name} copy mismatch`);
  evidence.copiedFiles[name] = {source: from, destination: to, sha256: hash(actual), preserved: adapterOnly, matchesSource: actual.equals(before)};
}
for (const name of ['NativeHostPerformanceExample.js', 'BoundPerformanceScreen.js', 'PerformanceExample.js']) {
  await copyFile(path.join(here, name), path.join(moduleDir, name));
}
await copyFile(path.join(here, 'initialNavigationStateFromLaunch.js'), path.join(js, 'utils/initialNavigationStateFromLaunch.js'));

async function patch(relative, transform) {
  const file = path.join(js, relative);
  const before = await readFile(file, 'utf8');
  const after = transform(before);
  if (before !== after) await writeFile(file, after);
  evidence.changedFiles.push({file, sha256: hash(after), changedThisRun: before !== after});
}
function once(text, search, replacement) {
  assert.equal(text.split(search).length, 2, `Expected one patch anchor: ${search}`);
  return text.replace(search, replacement);
}
for (const platform of ['ios', 'android']) {
  await patch(`utils/RNTesterList.${platform}.js`, text => {
    const marker = "key: 'NativeHostPerformanceExample'";
    if (text.includes(marker)) { assert.equal(text.split(marker).length, 2); return text; }
    return once(text, 'const Components: Array<RNTesterModuleInfo> = [', `const Components: Array<RNTesterModuleInfo> = [
  {
    key: 'NativeHostPerformanceExample',
    category: 'Basic',
    module: require('../examples/NativeHostPerformance/NativeHostPerformanceExample'),
  },`);
  });
}
await patch('RNTesterAppShared.js', text => {
  if (text.includes("import {getInitialStateFromLaunchRoute}")) {
    assert.ok(text.includes('    exampleFromAppetizeParams,\n    getInitialStateFromLaunchRoute,'));
    return text;
  }
  let next = once(text, "import RNTesterList from './utils/RNTesterList';", "import RNTesterList from './utils/RNTesterList';\nimport {getInitialStateFromLaunchRoute} from './utils/initialNavigationStateFromLaunch';");
  next = once(next, '  getExamplesListWithRecentlyUsed,\n  initialNavigationState,\n', '  getExamplesListWithRecentlyUsed,\n');
  next = once(next, 'const RNTesterApp = ({\n  testList,', 'const RNTesterApp = ({\n  exampleFromAppetizeParams,\n  testList,');
  next = once(next, '}: {\n  testList?: {', '}: {\n  exampleFromAppetizeParams?: string,\n  testList?: {');
  return once(next, '    initialNavigationState,\n  );', '    exampleFromAppetizeParams,\n    getInitialStateFromLaunchRoute,\n  );');
});
await mkdir(path.join(js, '__tests__'), {recursive: true});
await copyFile(path.join(here, 'NativeHostPerformanceRoute-test.js'), path.join(js, '__tests__/NativeHostPerformanceRoute-test.js'));
const output = path.join(prototype, 'build/reference-performance-install.json');
await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
console.log(`Installed full RNTester performance module. Evidence: ${output}`);
