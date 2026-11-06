import assert from 'node:assert/strict';
import {createInterface} from 'node:readline';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {NativeDriver} from '../native-driver.mjs';
import {runProcess} from '../../performance/process.mjs';
import {startOwnedPublisher} from './publisher-process.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const {values} = parseArgs({options: {serial: {type: 'string'}, observer: {type: 'string'}, 'close-observer': {type: 'boolean', default: false}}});
if (!values.serial || !values.observer) throw Error('--serial and --observer are required');
const directory = path.join(root, 'build/refresh-mobile', `${Date.now()}-${process.pid}`);
await mkdir(directory, {recursive: true});
const report = {status: 'running', serial: values.serial, checks: [], errors: [], events: []};
const save = () => writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
await save();
const pkg = 'dev.nativehost.experiment';
const files = {
  revision: path.join(root, 'performance/refresh/application/revision.js'),
  component: path.join(root, 'performance/refresh/application/PerformanceScreen.jsx'),
};
const originals = {}, written = {};
const desktopConfig = path.join(directory, 'desktop.json');
let observer, publisher, ownedPublisher, publisherFailure, closing = false, connected = false, stageAttempted = false, previousRevision;
const run = (command, args, options = {}) => runProcess(command, args, {cwd: root, ...options});
const adb = (...args) => run('adb', ['-s', values.serial, ...args]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const events = report.events;
async function installedAPK() {
  const paths = (await adb('shell', 'pm', 'path', pkg)).split('\n').filter(Boolean).map(line => line.replace(/^package:/, '').trim());
  assert.ok(paths.length && paths.every(file => /^\/[A-Za-z0-9_./=+~\-]+\.apk$/.test(file)));
  return Promise.all(paths.map(async file => ({file, sha256: (await adb('shell', 'sha256sum', file)).split(/\s+/)[0]})));
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
const request = (method, params = {}) => observer.call(method, {package: pkg, ...params});
const find = selector => request('ui.find', {selector});
const waitText = text => request('ui.waitFor', {selector: {text}, timeoutMs: 15000});
async function change(name, source, marker) {
  const from = events.length;
  written[name] = source;
  await writeFile(files[name], source);
  const applied = await eventAfter(from, 'patch.applied');
  await waitText(`Revision: ${marker}`);
  assert.equal((await adb('shell', 'pidof', pkg)).trim(), report.initialProcessId);
  assert.equal(applied.generation, report.generation);
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
  const deadline = Date.now() + 5000;
  let prior, matches = 0;
  while (Date.now() < deadline) {
    const rows = visibleRows(await request('ui.snapshot'), await find({testID: 'perf-scroll'}));
    const key = JSON.stringify(rows);
    if (key === prior && rows.length) {if (++matches === 3) return rows;} else matches = 0;
    prior = key;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('OS-visible scroll geometry did not settle');
}
try {
  await adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
  await adb('shell', 'wm', 'dismiss-keyguard');
  const power = await adb('shell', 'dumpsys', 'power');
  assert.match(power, /mWakefulness=Awake/);
  for (const [name, file] of Object.entries(files)) originals[name] = await readFile(file, 'utf8');
  const workload = await readFile(path.join(root, 'performance/workload.js'));
  assert.deepEqual(workload, await readFile(path.join(root, 'build/reference/packages/rn-tester/js/examples/NativeHostPerformance/workload.js')));
  report.workloadSha256 = hash(workload);
  report.installedBefore = await installedAPK();
  try {
    const startup = JSON.parse(await adb('shell', `run-as ${pkg} cat files/dev-startup.json`));
    previousRevision = startup.bundleRevision;
  } catch { previousRevision = 'packaged'; }
  assert.ok(previousRevision === 'packaged' || /^[0-9]{1,96}$/.test(previousRevision));
  report.previousRevision = previousRevision;
  observer = await NativeDriver.connect(JSON.parse(await readFile(values.observer, 'utf8')));
  report.observer = await observer.call('session.describe');
  assert.equal(report.observer.observation, 'operating-system-accessibility');
  assert.equal(report.observer.inputMechanism, 'system-coordinate-and-key-events');
  ownedPublisher = startOwnedPublisher(['scripts/refresh-watch.mjs', '--output-directory', path.join(directory, 'publisher')],
    {cwd: root, onFailure: error => {publisherFailure ??= error;}});
  publisher = ownedPublisher.child;
  publisher.stdin.on('error', error => {if (!closing) publisherFailure ??= error;});
  publisher.stderr.on('data', bytes => {report.stderr = ((report.stderr || '') + bytes).slice(-65536);});
  createInterface({input: publisher.stdout}).on('line', line => {
    try {events.push(JSON.parse(line));} catch {publisherFailure ??= Error('Invalid publisher output');}
  });
  const initial = await eventAfter(0, 'initial.ready');
  report.initial = initial;
  stageAttempted = true;
  await run('python3', ['scripts/connect-refresh-android.py', '--serial', values.serial,
    '--session', initial.configFile, '--revision-directory', path.dirname(initial.bundleFile), '--output', desktopConfig], {timeout: 120000});
  connected = true;
  const from = events.length;
  publisher.stdin.write(JSON.stringify({method: 'connect', config: desktopConfig}) + '\n');
  const ready = await eventAfter(from, 'connected');
  report.generation = ready.generation;
  report.initialProcessId = (await adb('shell', 'pidof', pkg)).trim();
  await waitText('Revision: baseline-000');
  await request('ui.tap', {selector: {label: 'Update'}});
  await waitText('Count: 1; order: forward');
  await request('ui.type', {selector: {label: 'Performance input'}, text: 'native refresh input', clear: true});
  await waitText('Input: native refresh input');
  const beforeInput = await find({label: 'Performance input'});
  assert.equal(beforeInput.focused, true);
  assert.ok(beforeInput.selectionStart >= 0 && beforeInput.selectionStart === beforeInput.selectionEnd);
  const marker = `refresh-${Date.now()}`;
  await change('revision', `export const REVISION = '${marker}';\n`, marker);
  const afterInput = await find({label: 'Performance input'});
  assert.equal(afterInput.focused, true);
  assert.equal(afterInput.selectionStart, beforeInput.selectionStart);
  assert.equal(afterInput.selectionEnd, beforeInput.selectionEnd);
  report.checks.push({name: 'actual-OS-state-focus-selection-preserved', beforeInput, afterInput});
  await request('ui.dismissKeyboard');
  await stableRows();
  await request('ui.scroll', {selector: {testID: 'perf-scroll'}, direction: 'down', durationMs: 350});
  const beforeRows = await stableRows();
  assert.ok(beforeRows.length && !beforeRows.some(row => row.text === 'Row 0: 1'));
  await change('revision', `export const REVISION = '${marker}-scroll';\n`, `${marker}-scroll`);
  const afterRows = await stableRows();
  assert.deepEqual(afterRows, beforeRows);
  report.checks.push({name: 'OS-visible-scroll-geometry-preserved', beforeRows, afterRows});
  const errorFrom = events.length;
  written.revision = 'export const = ;\n'; await writeFile(files.revision, written.revision);
  await eventAfter(errorFrom, 'compiler.error');
  await waitText(`Revision: ${marker}-scroll`);
  await waitText('Count: 1; order: forward');
  assert.equal((await adb('shell', 'pidof', pkg)).trim(), report.initialProcessId);
  await change('revision', `export const REVISION = '${marker}-fixed';\n`, `${marker}-fixed`);
  report.checks.push({name: 'compile-error-and-fix-retain-running-application'});
  assert.ok(originals.component.includes('revision={REVISION}'));
  await change('component', originals.component.replace('revision={REVISION}', 'revision={"body:" + REVISION}'), `body:${marker}-fixed`);
  await request('ui.tap', {selector: {label: 'Update'}});
  await waitText('Count: 2; order: forward');
  report.checks.push({name: 'actual-component-body-update-preserves-state-and-working-handler'});
  report.installedAfter = await installedAPK();
  assert.deepEqual(report.installedAfter, report.installedBefore);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.errors.push({message: String(error), stack: error.stack});
} finally {
  closing = true;
  async function cleanup(name, task) {
    try {await task();} catch (error) {report.status = 'failed'; report.errors.push({phase: name, message: String(error)});}
  }
  await cleanup('publisher', async () => {
    if (!publisher) return;
    await ownedPublisher.stop();
    if (report.stderr?.trim()) throw Error('Unexpected publisher stderr');
    const childReport = JSON.parse(await readFile(path.join(directory, 'publisher/report.json'), 'utf8'));
    assert.equal(childReport.status, 'stopped');
    assert.equal(childReport.pendingPatches, 0);
  });
  for (const name of Object.keys(written)) await cleanup(`restore-${name}`, async () => {
    assert.equal(await readFile(files[name], 'utf8'), written[name], 'Source changed externally; refusing to overwrite it');
    await writeFile(files[name], originals[name]);
  });
  if (connected) await cleanup('forward', () => run('python3', ['scripts/connect-refresh-android.py', '--serial', values.serial, '--output', desktopConfig, '--disconnect']));
  if (stageAttempted) await cleanup('restore-fixture', async () => {
    const shutdown = await adb('shell', 'am', 'broadcast', '-n', `${pkg}/dev.nativehost.DebugReloadReceiver`, '-a', `${pkg}.PREPARE_RELOAD`);
    assert.ok(shutdown.includes('result=-1'));
    await adb('shell', 'am', 'force-stop', pkg);
    const args = ['shell', 'am', 'start', '-W', '-n', `${pkg}/dev.nativehost.HostActivity`];
    if (previousRevision !== 'packaged') args.push('--es', 'devRevision', previousRevision);
    await adb(...args);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const currentPID = (await adb('shell', 'pidof', pkg)).trim();
      const receipt = JSON.parse(await adb('shell', `run-as ${pkg} cat files/dev-startup.json`));
      if (String(receipt.processId) === currentPID && receipt.bundleRevision === previousRevision &&
          receipt.runtimeStarted === true && receipt.healthy === true && receipt.failure === null &&
          currentPID !== report.initialProcessId) {
        report.restoredFixture = receipt;
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error('No fresh healthy startup receipt for the restored fixture');
  });
  await cleanup('observer', async () => {if (values['close-observer']) await observer?.close(); else observer?.socket.destroy();});
  await save();
}
console.log(JSON.stringify({status: report.status, checks: report.checks.length, report: path.join(directory, 'report.json')}));
if (report.status !== 'passed') process.exitCode = 1;
