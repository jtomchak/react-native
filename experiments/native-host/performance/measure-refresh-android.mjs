import assert from 'node:assert/strict';
import {createInterface} from 'node:readline';
import {readFile, writeFile, mkdir, copyFile, chmod, open, unlink, readdir} from 'node:fs/promises';
import {createHash, randomBytes} from 'node:crypto';
import {parseArgs} from 'node:util';
import {createRequire} from 'node:module';
import {performance} from 'node:perf_hooks';
import path from 'node:path';
import {prototypeRoot as root} from '../scripts/bundle-config.mjs';
import {NativeDriver} from '../testing/native-driver.mjs';
import {startOwnedPublisher} from '../testing/refresh/publisher-process.mjs';
import {collectPaired} from './paired-run.mjs';
import {runProcess} from './process.mjs';
import {observeSourceEdit, validateTerminal} from './refresh/measurement.mjs';

const {values} = parseArgs({options: {
  serial: {type: 'string'}, observer: {type: 'string'}, count: {type: 'string', default: '30'},
  warmups: {type: 'string', default: '3'}, 'metro-port': {type: 'string', default: '18791'},
  transport: {type: 'string', default: path.join(root, 'dev-refresh/target/release/native-host-refresh-transport')},
}});
if (!values.serial || !values.observer) throw Error('--serial and --observer private config are required; caller owns Metro/observer launchers');
const count = Number(values.count), warmups = Number(values.warmups), metroPort = Number(values['metro-port']);
assert.ok(Number.isSafeInteger(count) && count >= 1 && count <= 1000);
assert.ok(Number.isSafeInteger(warmups) && warmups >= 0 && warmups <= 100);
assert.ok(Number.isInteger(metroPort) && metroPort >= 1024 && metroPort <= 65535);
assert.ok(!process.env.NH_REFRESH_TEST_PREPARE_DELAY_MS || process.env.NH_REFRESH_TEST_PREPARE_DELAY_MS === '0', 'Injected preparation delay is not a performance measurement');
const runId = `${Date.now()}-${process.pid}-${randomBytes(4).toString('hex')}`;
const directory = path.join(root, 'build/performance/android-refresh', runId);
await mkdir(directory, {recursive: true, mode: 0o700});
const graph = path.join(directory, 'graph'), application = path.join(graph, 'application');
const publisherDirectory = path.join(directory, 'publisher'), desktopConfig = path.join(directory, 'desktop.json');
const packages = {reference: 'dev.nativehost.reference', candidate: 'dev.nativehost.experiment'};
const referenceDirectory = path.join(root, 'build/reference/packages/rn-tester/js/examples/NativeHostPerformance');
const files = {reference: path.join(referenceDirectory, 'revision.js'), candidate: path.join(application, 'revision.js')};
const lockFile = path.join(referenceDirectory, '.android-refresh-measurement.lock');
const lockContents = JSON.stringify({runId, processId: process.pid, directory}) + '\n';
const report = {schemaVersion: 1, status: 'running', mode: 'default-development-refresh', platform: 'android', serial: values.serial,
  runId, count, warmups, startedAt: new Date().toISOString(), events: [], errors: []};
const save = () => writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const run = (executable, args, options = {}) => runProcess(executable, args, {cwd: root, ...options});
const adb = (...args) => run('adb', ['-s', values.serial, ...args]);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let observer, publisher, ownedPublisher, publisherFailure, connected = false, stageAttempted = false;
let locked = false, referenceOriginal, referenceWritten, previousRevision, candidateGeneration, baseRevision, candidateSequence = 1n, preparations = 0;
let ownedCandidatePID, candidateWritten;
const binary = path.join(directory, 'native-host-refresh-transport');
const immutable = new Map();
const events = report.events;
await save();

async function pin(file) {const digest = hash(await readFile(file)); immutable.set(file, digest); return digest;}
async function pinTree(directory) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await pinTree(file);
    else if (entry.isFile()) await pin(file);
  }
}
async function installedIdentity(packageName) {
  const paths = (await adb('shell', 'pm', 'path', packageName)).split('\n').filter(Boolean).map(line => line.replace(/^package:/, '').trim());
  assert.ok(paths.length && paths.every(file => /^\/[A-Za-z0-9_./=+~\-]+\.apk$/.test(file)), 'Unexpected installed APK path');
  return Promise.all(paths.map(async file => ({file, sha256: (await adb('shell', 'sha256sum', file)).split(/\s+/)[0]})));
}
async function pid(packageName) {const value = await adb('shell', 'pidof', packageName); assert.match(value, /^\d+$/, 'Expected one target process'); return value;}
function publisherHealthy() {
  if (publisherFailure) throw publisherFailure;
  const failure = events.find(event => ['compiler.error', 'reload-required', 'stopped'].includes(event.event));
  if (failure) throw Error(`Publisher cannot continue: ${failure.event}`);
}
async function eventAfter(index, name) {
  const deadline = performance.now() + 30000;
  while (performance.now() < deadline) {
    publisherHealthy();
    const found = events.slice(index).find(event => event.event === name);
    if (found) return found;
    await pause(10);
  }
  throw Error(`Timed out awaiting ${name}`);
}
const request = (backend, method, params = {}) => observer.call(method, {package: packages[backend], ...params});
const waitText = (backend, text) => request(backend, 'ui.waitFor', {selector: {text}, timeoutMs: 15000});
const findInput = backend => request(backend, 'ui.find', {selector: {label: 'Performance input'}});
function inputIdentity(input) {return {text: input.text, focused: input.focused, selectionStart: input.selectionStart, selectionEnd: input.selectionEnd};}
async function settledInput(backend, expected) {
  let previous;
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const input = await findInput(backend), key = JSON.stringify(inputIdentity(input));
    if (input.exists && input.visible && input.text === expected && input.focused === true &&
        input.selectionStart >= 0 && input.selectionStart === input.selectionEnd && key === previous) return inputIdentity(input);
    previous = key; await pause(20);
  }
  throw Error('System input/focus/selection did not settle');
}
try {
  // This lease does not override external edits: per-write and restore CAS remain mandatory.
  const lease = await open(lockFile, 'wx', 0o600); locked = true;
  try {await lease.writeFile(lockContents);} finally {await lease.close();}
  referenceOriginal = await readFile(files.reference, 'utf8');
  const revisionLiteral = /^export const REVISION = ['"]([^'"\r\n]+)['"];\s*$/;
  assert.match(referenceOriginal, revisionLiteral, 'Reference revision must be a simple baseline literal');
  const power = await adb('shell', 'dumpsys', 'power');
  assert.match(power, /mWakefulness=Awake/); assert.match(power, /Display Power: state=ON/);
  const metro = await fetch(`http://127.0.0.1:${metroPort}/status`, {signal: AbortSignal.timeout(5000)});
  assert.equal(await metro.text(), 'packager-status:running', 'Caller-owned Metro is unavailable');
  const workload = await readFile(path.join(root, 'performance/workload.js'));
  assert.deepEqual(workload, await readFile(path.join(referenceDirectory, 'workload.js')), 'Workload bytes differ');
  await mkdir(application, {recursive: true});
  // Only these two canonical application sources are copied. They are never written.
  const wrapper = await readFile(path.join(root, 'performance/refresh/application/PerformanceScreen.jsx'));
  const revision = await readFile(path.join(root, 'performance/refresh/application/revision.js'));
  assert.match(wrapper.toString(), /revision=\{REVISION\}/, 'Canonical wrapper is under a functional edit; wait for its owner');
  assert.match(revision.toString(), revisionLiteral);
  await writeFile(path.join(application, 'PerformanceScreen.jsx'), wrapper, {flag: 'wx'});
  await writeFile(files.candidate, revision, {flag: 'wx'});
  const renderer = path.join(root, 'js/renderer.js'), bootstrap = path.join(root, 'js/dev/renderer-bootstrap.js');
  await writeFile(path.join(graph, 'BoundPerformanceScreen.js'), `import React from 'react';\nimport * as Native from ${JSON.stringify(renderer)};\nimport {createPerformanceScreen} from ${JSON.stringify(path.join(root, 'performance/workload.js'))};\nexport default createPerformanceScreen(React, Native);\n`, {flag: 'wx'});
  await writeFile(path.join(graph, 'entry.js'), `import React from 'react';\nimport * as Native from ${JSON.stringify(renderer)};\nimport {attachRefreshRenderer} from ${JSON.stringify(bootstrap)};\nimport PerformanceScreen from './application/PerformanceScreen.jsx';\nattachRefreshRenderer(Native.reconciler);\nglobalThis.__nhDispatch=(method,params={})=>{if(method==='app.event')return Native.dispatchEvent(params);throw new Error('Unsupported performance method: '+method);};\nNative.render(React.createElement(PerformanceScreen));\n`, {flag: 'wx'});
  const transportSourceHash = hash(await readFile(values.transport));
  await copyFile(values.transport, binary); await chmod(binary, 0o500);
  assert.equal(await pin(binary), transportSourceHash, 'Transport changed while being copied');
  report.transportSource = {path: path.resolve(values.transport), sha256: transportSourceHash};
  for (const file of [path.join(graph, 'entry.js'), path.join(graph, 'BoundPerformanceScreen.js'), path.join(application, 'PerformanceScreen.jsx'),
    path.join(root, 'performance/workload.js'), path.join(root, 'package.json'), path.join(root, 'package-lock.json'),
    ...['workload.js','NativeHostPerformanceExample.js','PerformanceExample.js','BoundPerformanceScreen.js'].map(name => path.join(referenceDirectory, name)),
    path.join(root, 'platforms/android/app/build.gradle'), path.join(root, 'platforms/android/build.gradle'),
    ...['performance/measure-refresh-android.mjs', 'performance/refresh/measurement.mjs', 'performance/paired-run.mjs',
      'performance/process.mjs', 'testing/native-driver.mjs', 'testing/refresh/publisher-process.mjs'].map(file => path.join(root, file)),
    path.join(root, 'build/reference/performance-android-setup.json'), path.join(root, 'build/reference/yarn.lock'),
    path.join(root, 'build/reference/packages/react-native/gradle/libs.versions.toml')]) await pin(file);
  for (const subtree of ['js', 'scripts', 'dev-refresh/src', 'runtime', 'core/src', 'platforms/android/app/src/main', 'platforms/android/app/src/debug', 'platforms/android/app/src/release']) await pinTree(path.join(root, subtree));
  report.installedBefore = {};
  for (const backend of Object.keys(packages)) report.installedBefore[backend] = await installedIdentity(packages[backend]);
  report.observerInstalledBefore = {};
  for (const packageName of ['dev.nativehost.observer', 'dev.nativehost.observer.test']) report.observerInstalledBefore[packageName] = await installedIdentity(packageName);
  let observerConfig;
  try {observerConfig = JSON.parse(await readFile(values.observer, 'utf8'));}
  catch {throw Error('Observer configuration could not be read as JSON');}
  observer = await NativeDriver.connect(observerConfig);
  const observerIdentity = await observer.call('session.describe');
  assert.equal(observerIdentity.platform, 'android'); assert.equal(observerIdentity.driver, 'external-instrumentation-uiautomation');
  assert.equal(observerIdentity.observation, 'operating-system-accessibility'); assert.equal(observerIdentity.inputMechanism, 'system-coordinate-and-key-events');
  const previousStartup = await adb('shell', `run-as ${packages.candidate} sh -c 'if [ -f files/dev-startup.json ]; then cat files/dev-startup.json; else echo absent; fi'`);
  previousRevision = previousStartup === 'absent' ? 'packaged' : JSON.parse(previousStartup).bundleRevision;
  assert.ok(previousRevision === 'packaged' || /^[0-9]{1,96}$/.test(previousRevision));
  report.previousCandidateRevision = previousRevision;
  const existingSession = await adb('shell', `run-as ${packages.candidate} sh -c 'if [ -e files/native-dev-session.json ] || [ -L files/native-dev-session.json ]; then echo present; else echo absent; fi'`);
  assert.equal(existingSession, 'absent', 'Refusing to replace an existing development session');
  ownedPublisher = startOwnedPublisher(['scripts/refresh-watch.mjs', '--entry', path.join(graph, 'entry.js'),
    '--application-directory', application, '--output-directory', publisherDirectory, '--transport', binary],
    {cwd: root, onFailure: error => {publisherFailure ??= error;}});
  publisher = ownedPublisher.child;
  publisher.stderr.on('data', bytes => {report.publisherStderr = ((report.publisherStderr || '') + bytes).slice(-65536);});
  createInterface({input: publisher.stdout}).on('line', line => {
    try {events.push({...JSON.parse(line), observedAtMs: performance.now()});}
    catch {publisherFailure ??= Error('Invalid publisher output');}
  });
  const initial = await eventAfter(0, 'initial.ready'); report.initial = initial;
  stageAttempted = true;
  await run('python3', ['scripts/connect-refresh-android.py', '--serial', values.serial, '--session', initial.configFile,
    '--revision-directory', path.dirname(initial.bundleFile), '--output', desktopConfig], {timeout: 120000});
  connected = true; ownedCandidatePID = await pid(packages.candidate);
  const connectionFrom = events.length;
  publisher.stdin.write(JSON.stringify({method: 'connect', config: desktopConfig}) + '\n');
  const ready = await eventAfter(connectionFrom, 'connected');
  assert.ok(Number.isSafeInteger(ready.generation) && ready.generation > 0);
  assert.equal(ready.sequence, '1'); assert.equal(ready.revision, initial.initialRevision);
  candidateGeneration = ready.generation; baseRevision = ready.revision;
  await waitText('candidate', `Revision: ${revision.toString().match(revisionLiteral)[1]}`);
  // Initial launch/setup is outside all samples; subsequent samples only foreground.
  await adb('shell', 'am', 'force-stop', packages.reference);
  const launch = await adb('shell', 'am', 'start', '-W', '-n', `${packages.reference}/com.facebook.react.uiapp.RNTesterActivity`, '--es', 'route', 'NativeHostPerformance');
  assert.doesNotMatch(launch, /Error:|Exception/);
  await waitText('reference', `Revision: ${referenceOriginal.match(revisionLiteral)[1]}`);
  const initialPIDs = {};
  for (const backend of Object.keys(packages)) initialPIDs[backend] = await pid(packages[backend]);
  const candidateRequire = createRequire(path.join(root, 'package.json'));
  const referenceRequire = createRequire(path.join(root, 'build/reference/package.json'));
  const referenceSetup = JSON.parse(await readFile(path.join(root, 'build/reference/performance-android-setup.json')));
  const candidateGradle = await readFile(path.join(root, 'platforms/android/app/build.gradle'), 'utf8');
  const context = report.context = {
    versions: {candidateReact: candidateRequire('react/package.json').version, referenceReact: referenceRequire('react/package.json').version,
      candidateRefresh: candidateRequire('react-refresh/package.json').version, referenceRefresh: referenceRequire('react-refresh/package.json').version,
      metro: referenceRequire('metro/package.json').version, rolldown: candidateRequire('rolldown/package.json').version,
      candidateHermes: candidateGradle.match(/hermes-android:([^:']+)/)?.[1], referenceHermesCompiler: referenceSetup.hermesCompiler,
      toolchainMetadata: 'Pinned Gradle files, reference native versions TOML and reference setup receipt; installed APK hashes recorded separately'},
    comparison: 'full RNTester Metro Fast Refresh versus native-host Refresh; same screen, different full app graph and capabilities',
    endpoint: 'host source-write invocation to exact visible OS accessibility marker response',
    phases: 'parent performance.now event receipt milestones; not isolated compiler/native/compositor durations',
    observer: observerIdentity, observerInstalledAPKs: report.observerInstalledBefore, workloadSha256: hash(workload), installedAPKs: report.installedBefore,
    referenceCommit: await run('git', ['-C', 'build/reference', 'rev-parse', 'HEAD']), node: process.version,
    serial: values.serial, device: await adb('shell', 'getprop', 'ro.build.fingerprint'), metroPort,
    sourcePaths: files, canonicalApplicationWritten: false, candidateWrapperSha256: hash(wrapper), candidateInitialRevisionSha256: hash(revision),
    pinnedSources: Object.fromEntries(immutable), pinnedTransport: binary, initialPIDs, candidateGeneration,
    ownership: {metro: 'external caller', observerLauncher: 'external caller', publisher: 'this run'},
    limitations: ['Accessibility observation includes observer/IPC overhead and is not a displayed frame',
      'Different full application graphs, native capabilities, Hermes and toolchain versions', 'Shared host/device thermal and background activity can affect results']};
  assert.equal(context.referenceCommit, 'fe398e511d7b4cfa22baf5b449e256ff9b7d66c4');
  await save();
  const collected = await collectPaired({reportPath: path.join(directory, 'samples.json'), context, count, warmups,
    prepare: async ({backend}) => {
      publisherHealthy();
      assert.match(await adb('shell', 'dumpsys', 'power'), /mWakefulness=Awake/);
      const activity = backend === 'reference' ? 'com.facebook.react.uiapp.RNTesterActivity' : 'dev.nativehost.HostActivity';
      await adb('shell', 'am', 'start', '-W', '--activity-reorder-to-front', '--activity-single-top', '-n', `${packages[backend]}/${activity}`);
      await request(backend, 'ui.waitFor', {selector: {label: 'Update'}, timeoutMs: 15000});
      assert.equal(await pid(packages[backend]), initialPIDs[backend], 'Process changed between samples');
      const snapshot = await request(backend, 'ui.snapshot');
      const state = snapshot.nodes.find(node => /^Count: \d+; order: forward$/.test(node.text));
      assert.ok(state, 'Expected workload state unavailable');
      const countBefore = Number(state.text.match(/^Count: (\d+)/)[1]) + 1;
      assert.equal((await request(backend, 'ui.tap', {selector: {label: 'Update'}})).performed, true);
      await waitText(backend, `Count: ${countBefore}; order: forward`);
      const input = `refresh-${runId.slice(-8)}-${++preparations}-${backend[0]}`;
      assert.equal((await request(backend, 'ui.type', {selector: {label: 'Performance input'}, text: input, clear: true})).performed, true);
      await waitText(backend, `Input: ${input}`);
      const inputBefore = await settledInput(backend, input);
      const sourceBefore = await readFile(files[backend], 'utf8');
      if (backend === 'reference') assert.equal(sourceBefore, referenceWritten ?? referenceOriginal, 'Concurrent reference source edit');
      else assert.equal(sourceBefore, candidateWritten ?? revision.toString(), 'Concurrent isolated candidate source edit');
      return {countBefore, inputBefore, processId: initialPIDs[backend], sourceBefore, eventIndex: events.length,
        candidateSequence: candidateSequence.toString(), candidateBaseRevision: baseRevision};
    },
    measure: async ({backend, revision, expectedMarker, preparation}) => observeSourceEdit({
      packageName: packages[backend], expectedMarker,
      write: async () => {
        const source = `export const REVISION = ${JSON.stringify(revision)};\n`;
        // Source ownership was checked in prepare, outside the measured endpoint.
        if (backend === 'reference') referenceWritten = source; else candidateWritten = source;
        await writeFile(files[backend], source);
      },
      waitForMarker: () => waitText(backend, expectedMarker),
    }),
    verify: async ({backend, preparation, observation}) => {
      publisherHealthy();
      await waitText(backend, `Count: ${preparation.countBefore}; order: forward`);
      const inputAfter = inputIdentity(await findInput(backend));
      assert.deepEqual(inputAfter, preparation.inputBefore, 'Refresh changed native input/focus/selection');
      assert.equal(await pid(packages[backend]), preparation.processId, 'Refresh restarted the application');
      const validation = {sameProcess: true, statePreserved: true, countAfter: preparation.countBefore, inputAfter};
      if (backend === 'candidate') {
        const applied = await eventAfter(preparation.eventIndex, 'patch.applied');
        const batch = events.slice(preparation.eventIndex);
        const sent = batch.filter(event => event.event === 'patch.sent'), preparing = batch.filter(event => event.event === 'patch.preparing');
        assert.equal(sent.length, 1, 'Expected exactly one candidate patch'); assert.equal(preparing.length, 1);
        assert.equal(batch.filter(event => event.event === 'patch.applied').length, 1);
        const patchDirectory = path.dirname(sent[0].payloadFile);
        const ticket = JSON.parse(await readFile(path.join(patchDirectory, 'manifest.json')));
        const terminal = JSON.parse(await readFile(path.join(patchDirectory, 'terminal.json')));
        assert.equal(hash(await readFile(ticket.payloadFile)), ticket.payloadSha256);
        validation.terminal = validateTerminal({ticket, terminal, applied, generation: candidateGeneration,
          sequence: preparation.candidateSequence, baseRevision: preparation.candidateBaseRevision});
        validation.observedMilestonesMs = {
          sourceToPreparing: preparing[0].observedAtMs - observation.writeInvokedAtMs,
          preparingToSent: sent[0].observedAtMs - preparing[0].observedAtMs,
          sentToApplied: applied.observedAtMs - sent[0].observedAtMs,
          sourceToApplied: applied.observedAtMs - observation.writeInvokedAtMs};
        validation.nativeAcknowledgmentIncludedInLatencyGate = false;
        baseRevision = ticket.targetRevision; candidateSequence++;
      }
      return validation;
    }});
  report.measurements = collected.summary;
  report.status = 'passed';
} catch (error) {report.errors.push({phase: 'run', message: String(error), stack: error.stack});}
finally {
  const cleanup = async (phase, task) => {try {await task();} catch (error) {report.errors.push({phase, message: String(error)});}};
  await cleanup('publisher', async () => {
    if (!publisher) return;
    const exit = await ownedPublisher.stop();
    assert.equal(exit.code, 0); assert.equal(exit.signal, null);
    assert.ok(!report.publisherStderr?.trim(), 'Unexpected publisher stderr');
    const final = JSON.parse(await readFile(path.join(publisherDirectory, 'report.json')));
    assert.equal(final.status, 'stopped'); assert.equal(final.pendingPatches, 0);
    report.publisherFinal = {status: final.status, pendingPatches: final.pendingPatches, appliedCount: final.applied.length};
  });
  await cleanup('reference-source', async () => {
    if (referenceWritten === undefined) return;
    assert.equal(await readFile(files.reference, 'utf8'), referenceWritten, 'Concurrent reference edit: refusing restoration');
    await writeFile(files.reference, referenceOriginal);
    assert.equal(await readFile(files.reference, 'utf8'), referenceOriginal);
  });
  if (connected) await cleanup('development-session', () => run('python3', ['scripts/connect-refresh-android.py', '--serial', values.serial, '--output', desktopConfig, '--disconnect']));
  if (stageAttempted) await cleanup('prior-candidate-fixture', async () => {
    const remainingConfig = await adb('shell', `run-as ${packages.candidate} sh -c 'if [ -e files/native-dev-session.json ] || [ -L files/native-dev-session.json ]; then echo present; else echo absent; fi'`);
    assert.equal(remainingConfig, 'absent', 'A development session still owns the target; refusing to restart it');
    if (ownedCandidatePID) assert.equal(await pid(packages.candidate), ownedCandidatePID, 'Target process changed owners; refusing restoration');
    const shutdown = await adb('shell', 'am', 'broadcast', '-n', `${packages.candidate}/dev.nativehost.DebugReloadReceiver`, '-a', `${packages.candidate}.PREPARE_RELOAD`);
    assert.ok(shutdown.includes('result=-1'));
    await adb('shell', 'am', 'force-stop', packages.candidate);
    const args = ['shell', 'am', 'start', '-W', '-n', `${packages.candidate}/dev.nativehost.HostActivity`];
    if (previousRevision !== 'packaged') args.push('--es', 'devRevision', previousRevision);
    await adb(...args);
    const deadline = performance.now() + 15000;
    while (performance.now() < deadline) {
      const processId = await pid(packages.candidate);
      const receipt = JSON.parse(await adb('shell', `run-as ${packages.candidate} cat files/dev-startup.json`));
      if (String(receipt.processId) === processId && receipt.bundleRevision === previousRevision && receipt.runtimeStarted === true && receipt.healthy === true && receipt.failure === null && processId !== ownedCandidatePID) {
        report.restoredFixture = receipt; return;
      }
      await pause(100);
    }
    throw Error('Prior fixture has no fresh healthy startup receipt');
  });
  await cleanup('immutable-artifacts', async () => {
    for (const [file, digest] of immutable) assert.equal(hash(await readFile(file)), digest, `Pinned source/artifact changed: ${file}`);
    if (report.installedBefore) {
      report.installedAfter = {};
      for (const backend of Object.keys(report.installedBefore)) {
        report.installedAfter[backend] = await installedIdentity(packages[backend]);
        assert.deepEqual(report.installedAfter[backend], report.installedBefore[backend], 'Installed APK changed');
      }
    }
    if (report.observerInstalledBefore) {
      report.observerInstalledAfter = {};
      for (const packageName of Object.keys(report.observerInstalledBefore)) {
        report.observerInstalledAfter[packageName] = await installedIdentity(packageName);
        assert.deepEqual(report.observerInstalledAfter[packageName], report.observerInstalledBefore[packageName], 'Installed observer APK changed');
      }
    }
  });
  // Caller owns this observer server/launcher. Close our client only, never session.close.
  await cleanup('observer-client', async () => {observer?.socket.destroy();});
  await cleanup('reference-lease', async () => {
    if (!locked) return;
    assert.equal(await readFile(lockFile, 'utf8'), lockContents, 'Reference lease changed owners'); await unlink(lockFile);
  });
  if (report.errors.length) report.status = 'failed';
  report.finishedAt = new Date().toISOString(); await save();
}
console.log(`Android Refresh workflow evidence: ${path.join(directory, 'result.json')}`);
if (report.status !== 'passed') process.exitCode = 1;
