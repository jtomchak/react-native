import assert from 'node:assert/strict';
import {createInterface} from 'node:readline';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {NativeDriver} from '../native-driver.mjs';
import {runProcess} from '../../performance/process.mjs';
import {startOwnedPublisher} from './publisher-process.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const {values} = parseArgs({options: {serial: {type: 'string'}, observer: {type: 'string'}, 'close-observer': {type: 'boolean', default: false}}});
if (!values.serial || !values.observer) throw Error('--serial and --observer are required');
const directory = path.join(root, 'build/refresh-webview', `${Date.now()}-${process.pid}`);
await mkdir(directory, {recursive: true});
const report = {status: 'running', platform: 'android', serial: values.serial, checks: [], events: [], errors: []};
const save = () => writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
await save();
const pkg = 'dev.nativehost.experiment', app = path.join(root, 'testing/refresh/webview/application');
const files = {revision: path.join(app, 'revision.js'), component: path.join(app, 'Screen.jsx')};
const originals = {}, written = {}, desktop = path.join(directory, 'desktop.json');
let observer, publisher, ownedPublisher, publisherFailure, closing = false, staged = false, connected = false, previousRevision;
const run = (exe, args, options = {}) => runProcess(exe, args, {cwd: root, ...options});
const adb = (...args) => run('adb', ['-s', values.serial, ...args]);
async function poll(task, predicate, description) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const value = await task();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error(`Timed out: ${description}`);
}
async function eventAfter(index, event) {
  return poll(async () => {
    if (publisherFailure) throw publisherFailure;
    const events = report.events.slice(index);
    if (events.some(item => ['reload-required', 'stopped', 'compiler.error'].includes(item.event))) throw Error('Publisher cannot complete the requested update');
    return events.find(item => item.event === event);
  }, Boolean, event);
}
const request = (method, params) => observer.call(method, {package: pkg, ...params});
const waitText = text => request('ui.waitFor', {selector: {text}, timeoutMs: 15000});
const tap = label => request('ui.tap', {selector: {label}});
async function browserReport(name) {
  const value = await request('ui.text', {selector: {testID: `report-${name}`}});
  if (value.text.startsWith('waiting-')) return null;
  const data = JSON.parse(value.text);
  assert.equal(data.name, name); assert.equal(data.error, null);
  assert.match(data.nonce, /^[a-z0-9]+-[a-z0-9]+$/);
  return data;
}
async function probe() {
  const before = await Promise.all(['A', 'B'].map(browserReport));
  const sequence = Math.max(...before.map(item => item?.request || 0));
  await tap('Probe both');
  const after = await poll(() => Promise.all(['A', 'B'].map(browserReport)),
    rows => rows.every(row => row && row.request > sequence) && rows[0].request === rows[1].request,
    'fresh report from both real documents');
  return Object.fromEntries(after.map(row => [row.name, row]));
}
function state(value) {
  const {request, handler, ...document} = value;
  return document;
}
function sameDocuments(before, after, handler = 'original') {
  for (const name of ['A', 'B']) {
    assert.deepEqual(state(after[name]), state(before[name]));
    assert.equal(after[name].handler, handler);
  }
}
async function edit(name, source, marker) {
  const index = report.events.length;
  written[name] = source; await writeFile(files[name], source);
  const result = await eventAfter(index, 'patch.applied');
  assert.equal(result.generation, report.generation);
  assert.equal((await adb('shell', 'pidof', pkg)).trim(), report.processId);
  await waitText(`Revision: ${marker}`); await waitText('Native count: 1');
}
async function apkIdentity() {
  const files = (await adb('shell', 'pm', 'path', pkg)).split('\n').filter(Boolean).map(line => line.replace(/^package:/, '').trim());
  assert.ok(files.length && files.every(file => /^\/[A-Za-z0-9_./=+~\-]+\.apk$/.test(file)));
  return Promise.all(files.map(async file => ({file, sha256: (await adb('shell', 'sha256sum', file)).split(/\s+/)[0]})));
}
try {
  await adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'); await adb('shell', 'wm', 'dismiss-keyguard');
  assert.match(await adb('shell', 'dumpsys', 'power'), /mWakefulness=Awake/);
  for (const [name, file] of Object.entries(files)) originals[name] = await readFile(file, 'utf8');
  report.installedBefore = await apkIdentity();
  const prior = JSON.parse(await adb('shell', `run-as ${pkg} cat files/dev-startup.json`));
  previousRevision = prior.bundleRevision;
  assert.ok(previousRevision === 'packaged' || /^[0-9]{1,96}$/.test(previousRevision));
  observer = await NativeDriver.connect(JSON.parse(await readFile(values.observer, 'utf8')));
  report.observer = await observer.call('session.describe');
  assert.equal(report.observer.observation, 'operating-system-accessibility');
  ownedPublisher = startOwnedPublisher(['scripts/refresh-watch.mjs', '--output-directory', path.join(directory, 'publisher'),
    '--entry', path.join(app, '../entry.js'), '--application-directory', app], {cwd: root, onFailure: error => {publisherFailure ??= error;}});
  publisher = ownedPublisher.child;
  publisher.stdin.on('error', error => {if (!closing) publisherFailure ??= error;});
  publisher.stderr.on('data', bytes => {report.stderr = ((report.stderr || '') + bytes).slice(-65536);});
  createInterface({input: publisher.stdout}).on('line', line => {
    try {report.events.push(JSON.parse(line));} catch {publisherFailure ??= Error('Malformed publisher output');}
  });
  report.initial = await eventAfter(0, 'initial.ready');
  staged = true;
  await run('python3', ['scripts/connect-refresh-android.py', '--serial', values.serial, '--session', report.initial.configFile,
    '--revision-directory', path.dirname(report.initial.bundleFile), '--output', desktop], {timeout: 120000});
  connected = true;
  publisher.stdin.write(JSON.stringify({method: 'connect', config: desktop}) + '\n');
  report.generation = (await eventAfter(0, 'connected')).generation;
  report.processId = (await adb('shell', 'pidof', pkg)).trim();
  await waitText('Revision: browser-baseline');
  await poll(() => Promise.all(['A', 'B'].map(browserReport)), rows => rows.every(Boolean), 'two live documents');
  await tap('Native update'); await waitText('Native count: 1');
  await tap('Seed A'); await poll(() => browserReport('A'), row => row?.count === 1, 'A seeded');
  await tap('Seed B'); await poll(() => browserReport('B'), row => row?.count === 1, 'B seeded');
  const before = await probe();
  for (const name of ['A', 'B']) {
    assert.equal(before[name].value, `browser-${name}-1`); assert.equal(before[name].historyStep, 1);
    assert.equal(before[name].hash, '#state-1'); assert.equal(before[name].scrollY, 120);
    assert.ok(before[name].historyLength >= 2);
  }
  assert.notEqual(before.A.nonce, before.B.nonce);
  const marker = `browser-${Date.now()}`;
  await edit('revision', `export const REVISION = '${marker}';\n`, marker);
  const afterRevision = await probe(); sameDocuments(before, afterRevision);
  report.checks.push({name: 'two-document-nonce-form-scroll-history-survive-revision-update', before, after: afterRevision});
  assert.ok(originals.component.includes("const bodyTag = 'original'"));
  await edit('component', originals.component.replace("const bodyTag = 'original'", "const bodyTag = 'edited'"), marker);
  const afterBody = await probe(); sameDocuments(before, afterBody, 'edited');
  report.checks.push({name: 'component-body-update-retains-documents-and-replaces-message-handler', after: afterBody});
  await tap('Replace A');
  await poll(() => browserReport('A'), row => row && row.nonce !== before.A.nonce && row.request === 0, 'replacement document');
  const replacement = await probe();
  assert.equal(replacement.A.count, 0); assert.equal(replacement.A.value, 'seed');
  assert.notEqual(replacement.A.nonce, before.A.nonce); assert.deepEqual(state(replacement.B), state(before.B));
  await edit('revision', `export const REVISION = '${marker}-replacement';\n`, `${marker}-replacement`);
  const afterReplacement = await probe(); sameDocuments(replacement, afterReplacement, 'edited');
  report.checks.push({name: 'explicit-one-browser-remount-is-isolated-and-following-refresh-preserves-both', replacement, after: afterReplacement});
  report.installedAfter = await apkIdentity(); assert.deepEqual(report.installedAfter, report.installedBefore);
  report.status = 'passed';
} catch (error) {report.status = 'failed'; report.errors.push({message: String(error), stack: error.stack});}
finally {
  closing = true;
  async function cleanup(phase, operation) {
    try {await operation();} catch (error) {report.status = 'failed'; report.errors.push({phase, message: String(error)});}
  }
  await cleanup('publisher', async () => {
    if (!publisher) return;
    await ownedPublisher.stop();
    const result = JSON.parse(await readFile(path.join(directory, 'publisher/report.json')));
    assert.equal(result.status, 'stopped'); assert.equal(result.pendingPatches, 0);
    assert.ok(!report.stderr?.trim());
  });
  for (const name of Object.keys(written)) await cleanup(`restore-${name}`, async () => {
    assert.equal(await readFile(files[name], 'utf8'), written[name], 'Refusing to overwrite concurrent source change');
    await writeFile(files[name], originals[name]);
  });
  if (connected) await cleanup('forward', () => run('python3', ['scripts/connect-refresh-android.py', '--serial', values.serial, '--output', desktop, '--disconnect']));
  if (staged) await cleanup('restore-fixture', async () => {
    assert.match(await adb('shell', 'am', 'broadcast', '-n', `${pkg}/dev.nativehost.DebugReloadReceiver`, '-a', `${pkg}.PREPARE_RELOAD`), /result=-1/);
    await adb('shell', 'am', 'force-stop', pkg);
    const args = ['shell', 'am', 'start', '-W', '-n', `${pkg}/dev.nativehost.HostActivity`];
    if (previousRevision !== 'packaged') args.push('--es', 'devRevision', previousRevision);
    await adb(...args);
    report.restoredFixture = await poll(async () => {
      const receipt = JSON.parse(await adb('shell', `run-as ${pkg} cat files/dev-startup.json`));
      const pid = (await adb('shell', 'pidof', pkg)).trim();
      return String(receipt.processId) === pid && pid !== report.processId ? receipt : null;
    }, receipt => receipt?.bundleRevision === previousRevision && receipt.healthy && receipt.runtimeStarted && receipt.failure === null, 'healthy restored fixture');
  });
  await cleanup('observer', async () => {if (values['close-observer']) await observer?.close(); else observer?.socket.destroy();});
  await save();
}
console.log(JSON.stringify({status: report.status, checks: report.checks.length, report: path.join(directory, 'report.json')}));
if (report.status !== 'passed') process.exitCode = 1;
