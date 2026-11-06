import {build} from 'rolldown';
import {spawnSync} from 'node:child_process';
import {mkdir, readFile, writeFile, copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const expectedIDs = ['keyed-state-and-host-ref', 'layout-effect-cascade'];
function keys(value, expected, label) {
  if (!value || !isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort())) throw new Error(`Invalid ${label} fields`);
}
function validateObservations(item) {
  const o = item.observations;
  if (item.id === 'layout-effect-cascade') {
    keys(o, ['effects', 'widths', 'finalWidth', 'cleanup'], item.id);
    if (!Array.isArray(o.effects) || o.effects.length !== 2 || !Array.isArray(o.widths) || o.widths.length !== 2 ||
      ![...o.effects, ...o.widths, o.finalWidth, o.cleanup].every(Number.isFinite)) throw new Error('Invalid cascade observations');
  } else {
    keys(o, ['stages', 'effects', 'cleanup'], item.id);
    if (!Array.isArray(o.stages) || !isDeepStrictEqual(o.stages.map(s => s.phase), ['mounted', 'updated', 'reordered']) ||
      !Array.isArray(o.effects) || !o.effects.length || !Array.isArray(o.cleanup) || o.cleanup.length !== 2) throw new Error('Invalid keyed observations');
    for (const stage of o.stages) {
      keys(stage, ['phase', 'nodes'], 'stage');
      if (!Array.isArray(stage.nodes) || !isDeepStrictEqual(stage.nodes.map(n => n.name), ['a', 'b'])) throw new Error('Invalid keyed nodes');
      for (const node of stage.nodes) {
        keys(node, ['name', 'value', 'sameHostRef', 'y', 'width'], 'node');
        if (typeof node.sameHostRef !== 'boolean' || ![node.value, node.y, node.width].every(Number.isFinite)) throw new Error('Invalid node observation');
      }
    }
  }
}
export function compareContracts(reference, candidate) {
  for (const [name, value] of [['reference', reference], ['candidate', candidate]]) {
    if (value?.schemaVersion !== 1 || !Array.isArray(value.cases)) throw new Error(`${name}: invalid contract document`);
    const ids = value.cases.map(item => item.id).sort();
    if (!isDeepStrictEqual(ids, expectedIDs)) throw new Error(`${name}: missing, extra, duplicate, or empty cases: ${ids}`);
    for (const item of value.cases) {
      if (!item.observations || !Object.keys(item.observations).length) throw new Error(`${name}: empty observations for ${item.id}`);
      validateObservations(item);
    }
  }
  for (const item of reference.cases) {
    const other = candidate.cases.find(value => value.id === item.id);
    if (!isDeepStrictEqual(item.observations, other.observations)) {
      throw new Error(`Contract mismatch: ${item.id}\nreference=${JSON.stringify(item.observations)}\ncandidate=${JSON.stringify(other.observations)}`);
    }
  }
  return {schemaVersion: 1, passed: true, matchedCases: expectedIDs,
    referenceRuntime: reference.runtime, candidateRuntime: candidate.runtime,
    limitations: ['Two synchronous headless contracts only, not general RN compatibility or native widget validation.',
      'React/Hermes versions and renderer flags are recorded independently; matching observations do not erase runtime differences.',
      'Identity compares the same public native-host ref before/after updates, not cross-runtime numeric native ids.']};
}

async function run() {
  if (process.argv[2] === '--compare') {
    const [reference, candidate] = await Promise.all(process.argv.slice(3, 5).map(async file => JSON.parse(await readFile(file, 'utf8'))));
    console.log(JSON.stringify(compareContracts(reference, candidate), null, 2));
    return;
  }
  const out = path.join(root, 'build/differential-contracts');
  const referenceRoot = path.join(root, 'build/reference');
  const fixtureDir = path.join(referenceRoot, 'packages/react-native/src/private/testing/__tests__/native-host-contracts');
  await mkdir(out, {recursive: true});
  // A failed rerun must not leave a previous successful comparison as current.
  await writeFile(path.join(out, 'comparison.json'), JSON.stringify({schemaVersion: 1, passed: false, status: 'running-or-failed'}) + '\n');
  await mkdir(fixtureDir, {recursive: true});
  // Fantom/Metro restrict test modules to the reference checkout. Copies are
  // byte-identical and live only in its new, untracked fixture directory.
  await copyFile(path.join(root, 'testing/contracts/shared.js'), path.join(fixtureDir, 'shared.js'));
  await copyFile(path.join(root, 'testing/reference/NativeHostContracts-itest.js'), path.join(fixtureDir, 'NativeHostContracts-itest.js'));
  const source = await readFile(path.join(root, 'testing/contracts/shared.js'));
  const sourceHash = createHash('sha256').update(source).digest('hex');
  const env = {...process.env, ANDROID_HOME: process.env.ANDROID_HOME || '/Users/jesse/Library/Android/sdk',
    ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT || '/Users/jesse/Library/Android/sdk',
    JAVA_HOME: process.env.JAVA_HOME || '/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home',
    JAVA_TOOL_OPTIONS: '-XX:ActiveProcessorCount=4', GRADLE_OPTS: '-Dorg.gradle.daemon=false -Dorg.gradle.workers.max=4'};
  const ref = spawnSync('yarn', ['fantom', '/NativeHostContracts-itest\\.js$', '--runInBand', '--json', `--outputFile=${out}/reference-jest.json`],
    {cwd: referenceRoot, env, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024});
  const log = `${ref.stdout || ''}\n${ref.stderr || ''}`;
  await writeFile(path.join(out, 'reference.log'), log);
  if (ref.error || ref.status !== 0) throw new Error(`Reference failed: ${ref.error || ref.status}\n${log}`);
  const jest = JSON.parse(await readFile(path.join(out, 'reference-jest.json'), 'utf8'));
  if (!jest.success || jest.numPassedTests !== 1 || jest.numPendingTests !== 0) throw new Error('Reference contract did not execute exactly once');
  if (/isComponentError|\[Error:|Expected .+ but received/.test(log)) throw new Error('Reference logged component/assertion errors despite runner status');
  const records = log.split('\n').filter(line => line.includes('NH_CONTRACT_RESULT') && line.includes('{'));
  if (records.length !== 1) throw new Error(`Expected one reference record, received ${records.length}`);
  const record = records[0];
  const reference = JSON.parse(record.slice(record.indexOf('{'), record.lastIndexOf('}') + 1));
  await writeFile(path.join(out, 'reference.json'), JSON.stringify(reference, null, 2) + '\n');
  const bundle = path.join(out, 'candidate.bundle.js');
  await build({input: path.join(root, 'testing/contracts/candidate-entry.js'), platform: 'neutral',
    transform: {define: {'process.env.NODE_ENV': '"development"', __NH_TEST_HOOKS__: 'true'}},
    output: {file: bundle, format: 'iife'}});
  const native = spawnSync(path.join(root, 'build/headless/native-host'), ['--bundle', bundle], {
    cwd: root, input: [{id: 1, method: 'session.describe'}, {id: 2, method: 'contracts.run'}, {id: 3, method: 'runtime.pump'}].map(JSON.stringify).join('\n') + '\n',
    encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024});
  await writeFile(path.join(out, 'candidate.log'), `${native.stdout || ''}\n${native.stderr || ''}`);
  if (native.error || native.status !== 0) throw new Error(`Candidate process failed: ${native.error || native.status}`);
  const messages = native.stdout.trim().split('\n').map(line => JSON.parse(line));
  if (messages.length !== 3 || messages.some((m, i) => m.id !== i + 1 || m.error || m.result?.errors?.length)) throw new Error(`Candidate protocol failed: ${native.stdout}`);
  if (/\[error\]|Error:|isComponentError/i.test(native.stderr)) throw new Error(`Candidate logged errors: ${native.stderr}`);
  const candidate = messages[1].result;
  await writeFile(path.join(out, 'candidate.json'), JSON.stringify(candidate, null, 2) + '\n');
  const result = {...compareContracts(reference, candidate), sharedSourceSha256: sourceHash,
    referenceRevision: spawnSync('git', ['rev-parse', 'HEAD'], {cwd: referenceRoot, encoding: 'utf8'}).stdout.trim(),
    candidateNativeRuntime: messages[0].result};
  await writeFile(path.join(out, 'comparison.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`Matched ${result.matchedCases.length} shared contracts. Evidence: ${out}/comparison.json`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(error => { console.error(error); process.exitCode = 1; });
}
