import assert from 'node:assert/strict';
import {createInterface} from 'node:readline';
import {readFile, writeFile, mkdir, readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {NativeDriver} from '../native-driver.mjs';
import {runProcess} from '../../performance/process.mjs';
import {startOwnedPublisher} from './publisher-process.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const {values} = parseArgs({options: {simulator: {type: 'string'}, device: {type: 'string'}, app: {type: 'string'}, observer: {type: 'string'}, 'close-observer': {type: 'boolean', default: false}}});
if (!!values.simulator === !!values.device || !values.observer || (values.device && !values.app)) throw Error('Select --simulator or --device, plus --observer; physical runs require --app for signed artifact comparison');
const directory = path.join(root, 'build/refresh-mobile-ios', `${Date.now()}-${process.pid}`);
await mkdir(directory, {recursive: true});
const report = {status: 'running', simulator: values.simulator, device: values.device, checks: [], errors: [], events: [],
  limitations: ['Public XCTest snapshots do not expose text caret/selection or focused state; no preservation claim for those fields.',
    'Accessibility markers include OS query and IPC latency, not compositor presentation timestamps.']};
const save = () => writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
await save();
const pkg = 'dev.nativehost.prototype';
const files = {revision: path.join(root, 'performance/refresh/application/revision.js'),
  component: path.join(root, 'performance/refresh/application/PerformanceScreen.jsx')};
const originals = {}, written = {};
const desktopConfig = path.join(directory, 'desktop.json');
let observer, publisher, ownedPublisher, publisherFailure, closing = false, connected = false, stageAttempted = false, previousRevision;
const run = (command, args, options = {}) => runProcess(command, args, {cwd: root, ...options});
const sim = (command, ...args) => {
  const options = command === 'launch' && args[0] === '--terminate-running-process' ? [args.shift()] : [];
  return run('xcrun', ['simctl', command, ...options, values.simulator, ...args]);
};
const targetFlags = values.simulator ? ['--simulator', values.simulator] : ['--device', values.device];
let deviceCall = 0;
async function device(args) {
  const output = path.join(directory, `device-command-${++deviceCall}.json`);
  const separator = args.indexOf('--');
  const insertion = args[0] === 'device' && args[1] === 'process' && args[2] === 'launch' ? args.indexOf(pkg) : separator;
  const command = insertion < 0 ? [...args, '--json-output', output] : [...args.slice(0, insertion), '--json-output', output, ...args.slice(insertion)];
  await run('xcrun', ['devicectl', ...command]);
  const response = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(response.info.outcome, 'success'); return response.result;
}
async function launch(revision, terminate) {
  if (values.simulator) {
    const args = terminate ? ['--terminate-running-process', pkg] : [pkg];
    if (revision && revision !== 'packaged-development') args.push('--native-host-revision', revision);
    return sim('launch', ...args);
  }
  const args = ['device', 'process', 'launch', '--device', values.device];
  if (terminate) args.push('--terminate-existing');
  args.push(pkg, '--');
  if (revision && revision !== 'packaged-development') args.push('--native-host-revision', revision);
  return device(args);
}
async function processIdentity(pid) {
  if (values.simulator) return run('/bin/ps', ['-p', String(pid), '-o', 'lstart=']);
  const result = await device(['device', 'info', 'processes', '--device', values.device, '--filter', `processIdentifier == ${pid}`]);
  assert.equal(result.runningProcesses.length, 1);
  assert.equal(result.runningProcesses[0].processIdentifier, pid);
  return result.runningProcesses[0];
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const events = report.events;
const request = (method, params = {}) => observer.call(method, {package: pkg, ...params});
const find = selector => request('ui.find', {selector});
const waitText = text => request('ui.waitFor', {selector: {text}, timeoutMs: 15000});
async function health() {
  const surface = await find({testID: 'native-surface'});
  assert.equal(surface.exists, true);
  const result = JSON.parse(surface.text);
  assert.equal(result.healthy, true, JSON.stringify(result));
  return result;
}
async function artifacts() {
  const app = values.simulator ? await sim('get_app_container', pkg, 'app') : path.resolve(values.app);
  const names = ['NativeHost', 'app.bundle.js', 'Frameworks/hermesvm.framework/hermesvm',
    ...(await readdir(app)).filter(name => name.endsWith('.dylib'))].sort();
  return Object.fromEntries(await Promise.all(names.map(async name => [name, hash(await readFile(path.join(app, name)))])));
}
async function eventAfter(index, name) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (publisherFailure) throw publisherFailure;
    const failures = events.slice(index).filter(value => ['reload-required', 'stopped'].includes(value.event));
    if (failures.length) throw Error(`Publisher stopped: ${JSON.stringify(failures)}`);
    const event = events.slice(index).find(value => value.event === name);
    if (event) return event;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error(`Timed out awaiting publisher ${name}`);
}
async function sameHost() {
  const current = await health();
  assert.equal(current.pid, report.initialHealth.pid);
  assert.equal(current.runtimeGeneration, report.initialHealth.runtimeGeneration);
  assert.equal(current.runtimeEpoch, report.initialHealth.runtimeEpoch);
  const started = await processIdentity(current.pid);
  assert.deepEqual(started, report.processStart);
}
async function change(name, source, marker) {
  const from = events.length;
  written[name] = source; await writeFile(files[name], source);
  const applied = await eventAfter(from, 'patch.applied');
  await waitText(`Revision: ${marker}`);
  assert.equal(applied.generation, report.generation);
  await sameHost();
  await waitText('Count: 1; order: forward');
  assert.equal((await find({label: 'Performance input'})).text, 'native refresh input');
  return applied;
}
function visibleRows(snapshot, scroll) {
  const b = scroll.bounds;
  return snapshot.nodes.filter(node => node.visible && /^Row \d+: 1$/.test(node.text) &&
    node.bounds.y < b.y + b.height && node.bounds.y + node.bounds.height > b.y)
    .map(node => ({text: node.text, bounds: node.bounds}));
}
async function stableRows() {
  const deadline = Date.now() + 15000;
  let prior, matches = 0;
  while (Date.now() < deadline) {
    const rows = visibleRows(await request('ui.snapshot'), await find({testID: 'perf-scroll'}));
    const key = JSON.stringify(rows);
    if (key === prior && rows.length) {if (++matches === 2) return rows;} else matches = 0;
    prior = key;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('OS-visible scroll geometry did not settle');
}
try {
  for (const [name, file] of Object.entries(files)) originals[name] = await readFile(file, 'utf8');
  const workload = await readFile(path.join(root, 'performance/workload.js'));
  assert.deepEqual(workload, await readFile(path.join(root, 'build/reference/packages/rn-tester/js/examples/NativeHostPerformance/workload.js')));
  report.workloadSha256 = hash(workload); report.artifactsBefore = await artifacts();
  observer = await NativeDriver.connect(JSON.parse(await readFile(values.observer, 'utf8')));
  report.observer = await observer.call('session.describe');
  assert.equal(report.observer.mechanism, 'system-accessibility-and-coordinate');
  assert.equal(report.observer.independentProcess, true); assert.equal(report.observer.targetHost, 'none');
  // Starting the independent XCTest runner may foreground its runner shell.
  // Activate the existing candidate without terminating its current process.
  await launch(undefined, false);
  await request('ui.waitFor', {selector: {testID: 'native-surface'}, timeoutMs: 15000});
  report.previousHealth = await health(); previousRevision = report.previousHealth.loadedRevision;
  assert.ok(previousRevision === 'packaged-development' || /^[0-9]{1,64}$/.test(previousRevision));
  ownedPublisher = startOwnedPublisher(['scripts/refresh-watch.mjs', '--output-directory', path.join(directory, 'publisher')],
    {cwd: root, onFailure: error => {publisherFailure ??= error;}});
  publisher = ownedPublisher.child;
  publisher.stderr.on('data', bytes => {report.stderr = ((report.stderr || '') + bytes).slice(-65536);});
  createInterface({input: publisher.stdout}).on('line', line => {
    try {events.push(JSON.parse(line));} catch {publisherFailure ??= Error('Invalid publisher output');}
  });
  const initial = await eventAfter(0, 'initial.ready'); report.initial = initial;
  stageAttempted = true;
  report.connection = JSON.parse(await run('python3', ['scripts/connect-refresh-ios.py', ...targetFlags,
    '--session', initial.configFile, '--revision-directory', path.dirname(initial.bundleFile), '--output', desktopConfig], {timeout: 120000}));
  connected = true;
  if (values.device) {
    assert.ok(report.connection.artifactHashes, 'Physical host must report its loaded signed artifacts');
    for (const [name, digest] of Object.entries(report.connection.artifactHashes)) assert.equal(digest, report.artifactsBefore[name], `Installed artifact differs: ${name}`);
    for (const name of ['NativeHost', 'Frameworks/hermesvm.framework/hermesvm', 'app.bundle.js']) assert.ok(report.connection.artifactHashes[name]);
    report.artifactEvidence = 'Signed build hashes independently matched by native app receipt; same OS process and runtime epoch retained throughout patches.';
  }
  const from = events.length;
  publisher.stdin.write(JSON.stringify({method: 'connect', config: desktopConfig}) + '\n');
  const ready = await eventAfter(from, 'connected'); report.generation = ready.generation;
  await waitText('Revision: baseline-000');
  report.initialHealth = await health();
  assert.equal(report.initialHealth.pid, report.connection.processId);
  assert.equal(report.initialHealth.runtimeGeneration, report.generation);
  report.processStart = await processIdentity(report.initialHealth.pid);
  await request('ui.tap', {selector: {label: 'Update'}});
  await waitText('Count: 1; order: forward');
  await request('ui.type', {selector: {label: 'Performance input'}, text: 'native refresh input', clear: true});
  await waitText('Input: native refresh input');
  const beforeInput = await find({label: 'Performance input'});
  const marker = `refresh-${Date.now()}`;
  await change('revision', `export const REVISION = '${marker}';\n`, marker);
  const afterInput = await find({label: 'Performance input'});
  assert.equal(beforeInput.text, afterInput.text); assert.deepEqual(beforeInput.bounds, afterInput.bounds);
  report.checks.push({name: 'actual-OS-keyboard-counter-input-process-generation-preserved', beforeInput, afterInput});
  await request('ui.dismissKeyboard');
  await stableRows();
  await request('ui.scroll', {selector: {testID: 'perf-scroll'}, direction: 'down'});
  const beforeRows = await stableRows();
  assert.ok(beforeRows.length && !beforeRows.some(row => row.text === 'Row 0: 1'));
  await change('revision', `export const REVISION = '${marker}-scroll';\n`, `${marker}-scroll`);
  const afterRows = await stableRows(); assert.deepEqual(afterRows, beforeRows);
  report.checks.push({name: 'OS-visible-scroll-geometry-preserved', beforeRows, afterRows});
  const errorFrom = events.length;
  written.revision = 'export const = ;\n'; await writeFile(files.revision, written.revision);
  await eventAfter(errorFrom, 'compiler.error');
  await waitText(`Revision: ${marker}-scroll`); await waitText('Count: 1; order: forward'); await sameHost();
  await change('revision', `export const REVISION = '${marker}-fixed';\n`, `${marker}-fixed`);
  report.checks.push({name: 'compile-error-and-fix-retain-running-application'});
  assert.ok(originals.component.includes('revision={REVISION}'));
  await change('component', originals.component.replace('revision={REVISION}', 'revision={"body:" + REVISION}'), `body:${marker}-fixed`);
  await request('ui.tap', {selector: {label: 'Update'}}); await waitText('Count: 2; order: forward');
  report.checks.push({name: 'actual-component-body-update-preserves-state-and-working-handler'});
  if (values.simulator) await sim('io', 'screenshot', path.join(directory, 'final.png'));
  else {
    const screenshot = await request('ui.screenshot');
    assert.equal(screenshot.mimeType, 'image/png'); assert.ok(screenshot.byteLength <= 4 * 1024 * 1024);
    const bytes = Buffer.from(screenshot.base64, 'base64'); assert.equal(bytes.length, screenshot.byteLength);
    await writeFile(path.join(directory, 'final.png'), bytes);
  }
  report.artifactsAfter = await artifacts(); assert.deepEqual(report.artifactsAfter, report.artifactsBefore);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.errors.push({message: String(error), stack: error.stack});
} finally {
  closing = true;
  async function cleanup(name, task) {
    try {await task();} catch (error) {report.status = 'failed'; report.errors.push({phase: name, message: String(error)});}
  }
  await cleanup('publisher', async () => {
    if (!ownedPublisher) return;
    await ownedPublisher.stop();
    if (report.stderr?.trim()) throw Error('Unexpected publisher stderr');
    const childReport = JSON.parse(await readFile(path.join(directory, 'publisher/report.json'), 'utf8'));
    assert.equal(childReport.status, 'stopped'); assert.equal(childReport.pendingPatches, 0);
  });
  for (const name of Object.keys(written)) await cleanup(`restore-${name}`, async () => {
    assert.equal(await readFile(files[name], 'utf8'), written[name], 'Source changed externally; refusing to overwrite it');
    await writeFile(files[name], originals[name]);
  });
  if (connected) await cleanup('disconnect', () => run('python3', ['scripts/connect-refresh-ios.py', ...targetFlags, '--output', desktopConfig, '--disconnect']));
  if (stageAttempted && previousRevision) await cleanup('restore-fixture', async () => {
    await launch(previousRevision, true);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const current = await health();
        if (current.loadedRevision === previousRevision && current.pid !== report.initialHealth?.pid && current.runtimeEpoch !== report.initialHealth?.runtimeEpoch) {
          report.restoredFixture = current; return;
        }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error('No fresh healthy OS-observed restored fixture');
  });
  await cleanup('observer', async () => {
    if (values['close-observer']) await observer?.close();
    else observer?.socket.destroy();
  });
  await save();
}
console.log(JSON.stringify({status: report.status, checks: report.checks.length, report: path.join(directory, 'report.json')}));
if (report.status !== 'passed') process.exitCode = 1;
