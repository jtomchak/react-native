import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {performance} from 'node:perf_hooks';
import path from 'node:path';
import {prototypeRoot as root} from '../scripts/bundle-config.mjs';
import {NativeDriver} from '../testing/native-driver.mjs';
import {collectPaired} from './paired-run.mjs';
import {runProcess} from './process.mjs';

const {values} = parseArgs({options: {
  serial: {type: 'string'}, observer: {type: 'string'}, count: {type: 'string', default: '30'},
  warmups: {type: 'string', default: '3'}, adb: {type: 'string', default: 'adb'},
  mode: {type: 'string', default: 'full-reload'},
}});
if (!values.serial || !values.observer) throw new Error('--serial and --observer private config path are required');
if (!['full-reload', 'default-development'].includes(values.mode)) throw new Error('Invalid --mode');
const count = Number(values.count), warmups = Number(values.warmups);
const directory = path.join(root, 'build/performance/android-edits', `${Date.now()}-${process.pid}`);
await mkdir(directory, {recursive: true});
const summaryPath = path.join(directory, 'result.json');
const summary = {status: 'running', platform: 'android', mode: values.mode, serial: values.serial, errors: []};
const save = () => writeFile(summaryPath, JSON.stringify(summary, null, 2) + '\n');
await save();
const packages = {reference: 'dev.nativehost.reference', candidate: 'dev.nativehost.experiment'};
const files = {
  reference: path.join(root, 'build/reference/packages/rn-tester/js/examples/NativeHostPerformance/revision.js'),
  candidate: path.join(root, 'performance/revision.js'),
};
const originals = {}, written = {};
const errors = [];
let observer, watcher, watcherExit, watcherFailure;
const events = [];
const hash = data => createHash('sha256').update(data).digest('hex');
const run = (executable, args, options = {}) => runProcess(executable, args, {cwd: root, ...options});
const adb = (...args) => run(values.adb, ['-s', values.serial, ...args]);
async function installedIdentity(packageName) {
  const paths = (await adb('shell', 'pm', 'path', packageName)).split('\n').filter(Boolean).map(line => line.replace(/^package:/, '').trim());
  if (!paths.length || paths.some(file => !/^\/[A-Za-z0-9_./=+~\-]+\.apk$/.test(file))) throw new Error(`Invalid installed APK paths for ${packageName}`);
  return Promise.all(paths.map(async file => ({file, sha256: (await adb('shell', 'sha256sum', file)).split(/\s+/)[0]})));
}
async function revisionAfter(index, marker) {
  const deadline = performance.now() + 30000;
  while (performance.now() < deadline) {
    if (watcherFailure) throw watcherFailure;
    const next = events.slice(index).find(event => event.event === 'revision.ready');
    const failed = events.slice(index).find(event => event.event === 'bundle.failed');
    if (failed) throw new Error(`Candidate bundle failed: ${JSON.stringify(failed)}`);
    if (next) {
      const bundle = await readFile(path.join(next.directory, 'app.bundle.js'), 'utf8');
      if (!bundle.includes(marker)) throw new Error('Candidate publication contains the wrong revision');
      return next;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Candidate revision publication timed out');
}
try {
  for (const backend of Object.keys(files)) originals[backend] = await readFile(files[backend], 'utf8');
  const candidateWorkload = await readFile(path.join(root, 'performance/workload.js'));
  const referenceWorkload = await readFile(path.join(path.dirname(files.reference), 'workload.js'));
  if (!candidateWorkload.equals(referenceWorkload)) throw new Error('Shared workload source hashes differ');
  const identities = {};
  for (const backend of Object.keys(packages)) identities[backend] = await installedIdentity(packages[backend]);
  observer = await NativeDriver.connect(JSON.parse(await readFile(values.observer, 'utf8')));
  const observerIdentity = await observer.call('session.describe');
  if (observerIdentity.platform !== 'android' || observerIdentity.driver !== 'external-instrumentation-uiautomation' ||
      observerIdentity.observation !== 'operating-system-accessibility' || observerIdentity.inputMechanism !== 'system-coordinate-and-key-events') {
    throw new Error('Unexpected external observer identity');
  }
  watcher = spawn(path.join(root, 'dev/target/debug/native-host-dev'), ['--entry', 'performance/candidate-entry.js'], {cwd: root, stdio: ['pipe', 'pipe', 'pipe']});
  watcher.stdin.on('error', error => { watcherFailure ??= error; });
  watcher.stderr.on('data', bytes => { summary.watcherStderr = ((summary.watcherStderr || '') + bytes).slice(-65536); });
  createInterface({input: watcher.stdout}).on('line', line => {
    try { events.push({...JSON.parse(line), observedAtMs: performance.now()}); }
    catch (error) { watcherFailure ??= error; }
  });
  watcherExit = new Promise(resolve => {
    watcher.once('error', error => { watcherFailure = error; resolve({error}); });
    watcher.once('exit', (code, signal) => { watcherFailure ??= new Error(`Watcher exited ${code ?? signal}`); resolve({code, signal}); });
  });
  const baselineRevision = originals.candidate.match(/'([^']+)'/)?.[1];
  const baseline = await revisionAfter(0, baselineRevision);
  if (values.mode === 'default-development') {
    await run('python3', ['platforms/android/deploy-revision.py', baseline.directory, '--serial', values.serial, '--adb', values.adb]);
    await adb('shell', 'am', 'force-stop', packages.reference);
    await adb('shell', 'am', 'start', '-W', '-n', `${packages.reference}/com.facebook.react.uiapp.RNTesterActivity`, '--es', 'route', 'NativeHostPerformance');
  }
  const context = {
    comparison: 'full RNTester versus candidate; same screen, different full app graph and native capabilities',
    reload: values.mode === 'full-reload' ? 'full process restart on both hosts' : 'stock RN Fast Refresh versus candidate full process reload; state preservation verified separately',
    workloadSha256: hash(candidateWorkload),
    serial: values.serial, device: await adb('shell', 'getprop', 'ro.build.fingerprint'),
    installedAPKs: identities, observer: observerIdentity, node: process.version,
    referenceCommit: 'fe398e511d7b4cfa22baf5b449e256ff9b7d66c4',
    limitations: ['OS accessibility endpoint, not displayed frame', 'shared machine, external thermal/background conditions', 'different Hermes/toolchain versions', 'RNTester full module initialization retained'],
  };
  summary.context = context;
  await save();
  const report = await collectPaired({reportPath: path.join(directory, 'samples.json'), count, warmups, context,
    prepare: values.mode === 'default-development' ? async ({backend}) => {
      const packageName = packages[backend];
      const activity = backend === 'reference' ? 'com.facebook.react.uiapp.RNTesterActivity' : 'dev.nativehost.HostActivity';
      await adb('shell', 'am', 'start', '-W', '--activity-reorder-to-front', '--activity-single-top', '-n', `${packageName}/${activity}`);
      await observer.call('ui.waitFor', {package: packageName, selector: {label: 'Update'}, timeoutMs: 15000});
      const snapshot = await observer.call('ui.snapshot', {package: packageName});
      const state = snapshot.nodes.find(node => /^Count: \d+; order: forward$/.test(node.text));
      if (!state) throw new Error('Missing expected shared-screen state before edit');
      const countBefore = Number(state.text.match(/^Count: (\d+)/)[1]) + 1;
      const action = await observer.call('ui.tap', {package: packageName, selector: {label: 'Update'}});
      if (!action.performed) throw new Error('Could not seed state with system input');
      await observer.call('ui.waitFor', {package: packageName, selector: {text: `Count: ${countBefore}; order: forward`}, timeoutMs: 15000});
      const processId = await adb('shell', 'pidof', packageName);
      if (!/^\d+$/.test(processId)) throw new Error('Expected one target application process');
      return {countBefore, processId};
    } : undefined,
    verify: values.mode === 'default-development' ? async ({backend, preparation}) => {
      const packageName = packages[backend];
      const expectedCount = backend === 'reference' ? preparation.countBefore : 0;
      await observer.call('ui.waitFor', {package: packageName, selector: {text: `Count: ${expectedCount}; order: forward`}, timeoutMs: 15000});
      const processId = await adb('shell', 'pidof', packageName);
      const sameProcess = processId === preparation.processId;
      if (sameProcess !== (backend === 'reference')) throw new Error('Unexpected process preservation for development workflow');
      return {countBefore: preparation.countBefore, countAfter: expectedCount, statePreserved: backend === 'reference', sameProcess};
    } : undefined,
    measure: async ({backend, revision, expectedMarker}) => {
      const phases = {};
      const beforeEvents = events.length;
      const source = `export const REVISION = ${JSON.stringify(revision)};\n`;
      const writeAt = performance.now();
      await writeFile(files[backend], source); written[backend] = source;
      phases.sourceWrittenMs = performance.now() - writeAt;
      if (backend === 'candidate') {
        const published = await revisionAfter(beforeEvents, revision);
        phases.artifactObservedMs = performance.now() - writeAt;
        phases.revision = published.revision;
        phases.deployment = JSON.parse(await run('python3', ['platforms/android/deploy-revision.py', published.directory, '--serial', values.serial, '--adb', values.adb]));
      } else if (values.mode === 'full-reload') {
        await adb('shell', 'am', 'force-stop', packages.reference);
        phases.launch = await adb('shell', 'am', 'start', '-W', '-n', `${packages.reference}/com.facebook.react.uiapp.RNTesterActivity`, '--es', 'route', 'NativeHostPerformance');
        if (/Error:|Exception/.test(phases.launch)) throw new Error(`RNTester launch failed: ${phases.launch}`);
      }
      phases.action = backend === 'reference' && values.mode === 'default-development' ? 'source-write-only' : 'full-process-reload';
      phases.actionCompletedMs = performance.now() - writeAt;
      const observed = await observer.call('ui.waitFor', {package: packages[backend], selector: {text: expectedMarker}, timeoutMs: 15000});
      if (!observed.exists || !observed.visible || observed.package !== packages[backend]) throw new Error('Observer did not find a visible marker in the correct app');
      return {observedMarker: observed.text, mechanism: 'os-accessibility', observed, phases};
    }});
  for (const backend of Object.keys(packages)) {
    if (JSON.stringify(await installedIdentity(packages[backend])) !== JSON.stringify(identities[backend])) throw new Error(`Installed ${backend} APK changed during measurement`);
  }
  if (hash(await readFile(path.join(root, 'performance/workload.js'))) !== context.workloadSha256 ||
      hash(await readFile(path.join(path.dirname(files.reference), 'workload.js'))) !== context.workloadSha256) {
    throw new Error('Shared workload changed during measurement');
  }
  summary.measurements = report.summary;
} catch (error) { errors.push(error); }
finally {
  for (const backend of Object.keys(written)) {
    try {
      if (await readFile(files[backend], 'utf8') !== written[backend]) throw new Error(`Concurrent ${backend} source change: refusing restoration`);
      await writeFile(files[backend], originals[backend]);
    } catch (error) { errors.push(error); }
  }
  if (watcher) {
    if (!watcher.stdin.destroyed) watcher.stdin.end('quit\n');
    const timer = setTimeout(() => watcher.kill('SIGTERM'), 5000);
    const hardStop = setTimeout(() => watcher.kill('SIGKILL'), 10000);
    try {
      const result = await watcherExit;
      if (result.code !== 0) throw result.error || new Error(`Watcher cleanup failed: ${result.code ?? result.signal}`);
    } catch (error) { errors.push(error); }
    finally { clearTimeout(timer); clearTimeout(hardStop); }
  }
  try { await observer?.close(); } catch (error) { errors.push(error); }
  summary.status = errors.length ? 'failed' : 'passed';
  summary.errors = errors.map(error => ({name: error.name, message: error.message}));
  summary.finishedAt = new Date().toISOString();
  await save();
}
console.log(`Android workflow evidence: ${summaryPath}`);
if (errors.length) throw new AggregateError(errors, 'Android workflow measurement failed');
