import assert from 'node:assert/strict';
import {createInterface} from 'node:readline';
import {readFile, writeFile, mkdir, readdir, unlink, access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {NativeDriver} from '../native-driver.mjs';
import {runProcess} from '../../performance/process.mjs';
import {startOwnedPublisher} from './publisher-process.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const {values} = parseArgs({options: {simulator: {type: 'string'}, observer: {type: 'string'}, 'close-observer': {type: 'boolean', default: false}}});
if (!values.simulator || !values.observer) throw Error('--simulator and --observer are required; this packet never targets a physical device');
const directory = path.join(root, 'build/refresh-webview-ios', `${Date.now()}-${process.pid}`);
await mkdir(directory, {recursive: true});
const report = {status: 'running', platform: 'ios-simulator', simulator: values.simulator, checks: [], events: [], errors: [], browserReports: [],
  limitations: ['Browser mutations originate from normal native WebView commands, not OS keyboard/DOM automation.',
    'Accessibility observations include XCTest and IPC latency, not compositor presentation timestamps.']};
const save = () => writeFile(path.join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
await save();
const pkg = 'dev.nativehost.prototype', app = path.join(root, 'testing/refresh/webview/application');
const files = {revision: path.join(app, 'revision.js'), component: path.join(app, 'Screen.jsx')};
const originals = {}, written = {}, desktop = path.join(directory, 'desktop.json');
let observer, ownedPublisher, publisher, publisherFailure, connected = false, staged = false, previousRevision;
const run = (exe, args, options = {}) => runProcess(exe, args, {cwd: root, ...options});
const sim = (command, ...args) => {
  const options = command === 'launch' && args[0] === '--terminate-running-process' ? [args.shift()] : [];
  return run('xcrun', ['simctl', command, ...options, values.simulator, ...args]);
};
async function launch(revision, terminate = false) {
  const args = terminate ? ['--terminate-running-process', pkg] : [pkg];
  if (revision && revision !== 'packaged-development') args.push('--native-host-revision', revision);
  return sim('launch', ...args);
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function artifacts() {
  const directory = await sim('get_app_container', pkg, 'app');
  const files = ['NativeHost', 'app.bundle.js', 'Frameworks/hermesvm.framework/hermesvm',
    ...(await readdir(directory)).filter(name => name.endsWith('.dylib'))].sort();
  return Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(path.join(directory, file)))])));
}
const request = (method, params = {}) => observer.call(method, {package: pkg, ...params});
const waitText = text => request('ui.waitFor', {selector: {text}, timeoutMs: 15000});
const tap = label => request('ui.tap', {selector: {label}});
async function health() {
  const node = await request('ui.find', {selector: {testID: 'native-surface'}});
  assert.equal(node.exists, true);
  const value = JSON.parse(node.text); assert.equal(value.healthy, true, JSON.stringify(value)); return value;
}
async function poll(task, predicate, description) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const value = await task(); if (predicate(value)) return value;
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
async function browserReport(name) {
  const value = await request('ui.text', {selector: {testID: `report-${name}`}});
  if (value.text.startsWith('waiting-')) return null;
  const data = JSON.parse(value.text);
  report.browserReports.push(data); if (report.browserReports.length > 64) report.browserReports.shift();
  assert.equal(data.name, name); assert.equal(data.error, null, JSON.stringify(data));
  assert.match(data.nonce, /^[a-z0-9]+-[a-z0-9]+$/);
  return data;
}
async function probe() {
  const before = await Promise.all(['A', 'B'].map(browserReport));
  const sequence = Math.max(...before.map(item => item?.request || 0));
  await tap('Probe both');
  const after = await poll(() => Promise.all(['A', 'B'].map(browserReport)),
    rows => rows.every(row => row && row.request > sequence) && rows[0].request === rows[1].request,
    'fresh report from both real WebKit documents');
  return Object.fromEntries(after.map(row => [row.name, row]));
}
function documentState(value) {const {request, handler, ...document} = value; return document;}
function sameDocuments(before, after, handler = 'original') {
  for (const name of ['A', 'B']) {assert.deepEqual(documentState(after[name]), documentState(before[name])); assert.equal(after[name].handler, handler);}
}
async function sameHost() {
  const current = await health();
  for (const key of ['pid', 'runtimeGeneration', 'runtimeEpoch']) assert.equal(current[key], report.initialHealth[key]);
  assert.equal(await run('/bin/ps', ['-p', String(current.pid), '-o', 'lstart=']), report.processStart);
}
async function edit(name, source, marker) {
  const index = report.events.length; written[name] = source; await writeFile(files[name], source);
  const applied = await eventAfter(index, 'patch.applied'); assert.equal(applied.generation, report.generation);
  await waitText(`Revision: ${marker}`); await waitText('Native count: 1'); await sameHost();
}
try {
  for (const [name, file] of Object.entries(files)) originals[name] = await readFile(file, 'utf8');
  report.fixtureHashes = Object.fromEntries(await Promise.all([...Object.values(files), path.join(app, '../documents.mjs'), path.join(app, '../entry.js')]
    .map(async file => [path.relative(root, file), hash(await readFile(file))])));
  report.artifactsBefore = await artifacts();
  observer = await NativeDriver.connect(JSON.parse(await readFile(values.observer, 'utf8')));
  report.observer = await observer.call('session.describe');
  assert.equal(report.observer.mechanism, 'system-accessibility-and-coordinate');
  assert.equal(report.observer.independentProcess, true); assert.equal(report.observer.targetHost, 'none');
  await launch(); await request('ui.waitFor', {selector: {testID: 'native-surface'}, timeoutMs: 15000});
  report.previousHealth = await health(); previousRevision = report.previousHealth.loadedRevision;
  assert.ok(previousRevision === 'packaged-development' || /^[0-9]{1,64}$/.test(previousRevision));
  ownedPublisher = startOwnedPublisher(['scripts/refresh-watch.mjs', '--output-directory', path.join(directory, 'publisher'),
    '--entry', path.join(app, '../entry.js'), '--application-directory', app], {cwd: root, onFailure: error => {publisherFailure ??= error;}});
  publisher = ownedPublisher.child;
  publisher.stderr.on('data', bytes => {report.stderr = ((report.stderr || '') + bytes).slice(-65536);});
  createInterface({input: publisher.stdout}).on('line', line => {try {report.events.push(JSON.parse(line));} catch {publisherFailure ??= Error('Malformed publisher output');}});
  report.initial = await eventAfter(0, 'initial.ready'); staged = true;
  report.connection = JSON.parse(await run('python3', ['scripts/connect-refresh-ios.py', '--simulator', values.simulator,
    '--session', report.initial.configFile, '--revision-directory', path.dirname(report.initial.bundleFile), '--output', desktop], {timeout: 120000}));
  connected = true;
  publisher.stdin.write(JSON.stringify({method: 'connect', config: desktop}) + '\n');
  report.generation = (await eventAfter(0, 'connected')).generation;
  await waitText('Revision: browser-baseline');
  report.initialHealth = await health(); assert.equal(report.initialHealth.pid, report.connection.processId);
  assert.equal(report.initialHealth.runtimeGeneration, report.generation);
  report.processStart = await run('/bin/ps', ['-p', String(report.initialHealth.pid), '-o', 'lstart=']);
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
  report.checks.push({name: 'two-WebKit-documents-nonce-form-scroll-history-survive-revision-update', before, after: afterRevision});
  assert.ok(originals.component.includes("const bodyTag = 'original'"));
  await edit('component', originals.component.replace("const bodyTag = 'original'", "const bodyTag = 'edited'"), marker);
  const afterBody = await probe(); sameDocuments(before, afterBody, 'edited');
  report.checks.push({name: 'component-body-update-retains-documents-and-replaces-message-handler', after: afterBody});
  await tap('Replace A'); await poll(() => browserReport('A'), row => row && row.nonce !== before.A.nonce && row.request === 0, 'replacement document');
  const replacement = await probe(); assert.equal(replacement.A.count, 0); assert.equal(replacement.A.value, 'seed');
  assert.notEqual(replacement.A.nonce, before.A.nonce); assert.deepEqual(documentState(replacement.B), documentState(before.B));
  await edit('revision', `export const REVISION = '${marker}-replacement';\n`, `${marker}-replacement`);
  const afterReplacement = await probe(); sameDocuments(replacement, afterReplacement, 'edited');
  report.checks.push({name: 'explicit-one-browser-remount-is-isolated-and-following-refresh-preserves-both', replacement, after: afterReplacement});
  await sim('io', 'screenshot', path.join(directory, 'final.png'));
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.errors.push({message: String(error), stack: error.stack});
  try {report.failureSnapshot = await request('ui.snapshot'); await sim('io', 'screenshot', path.join(directory, 'failure.png'));}
  catch (diagnosticError) {report.errors.push({phase: 'failure-observation', message: String(diagnosticError)});}
} finally {
  async function cleanup(phase, operation) {try {await operation();} catch (error) {report.status = 'failed'; report.errors.push({phase, message: String(error)});}}
  await cleanup('publisher', async () => {
    if (!ownedPublisher) return; await ownedPublisher.stop();
    const result = JSON.parse(await readFile(path.join(directory, 'publisher/report.json')));
    assert.equal(result.status, 'stopped'); assert.equal(result.pendingPatches, 0); assert.ok(!report.stderr?.trim());
  });
  for (const name of Object.keys(written)) await cleanup(`restore-${name}`, async () => {
    assert.equal(await readFile(files[name], 'utf8'), written[name], 'Refusing to overwrite concurrent source change');
    await writeFile(files[name], originals[name]);
  });
  if (connected) await cleanup('disconnect', async () => {
    await run('python3', ['scripts/connect-refresh-ios.py', '--simulator', values.simulator, '--output', desktop, '--disconnect']);
    const container = await sim('get_app_container', pkg, 'data');
    await assert.rejects(access(path.join(container, 'native-dev-session.json')), {code: 'ENOENT'});
    for (const file of [desktop, `${desktop}.owner.json`, report.initial.configFile]) {
      assert.equal(JSON.parse(await readFile(file, 'utf8')).sessionId, report.initial.sessionId); await unlink(file);
    }
    report.sessionConfigRemoved = true;
  });
  if (staged && previousRevision) await cleanup('restore-fixture', async () => {
    await launch(previousRevision, true);
    report.restoredFixture = await poll(async () => {try {return await health();} catch {return null;}},
      value => value && value.loadedRevision === previousRevision && value.pid !== report.initialHealth?.pid && value.runtimeEpoch !== report.initialHealth?.runtimeEpoch,
      'fresh healthy OS-observed prior fixture');
  });
  await cleanup('artifacts', async () => {report.artifactsAfter = await artifacts(); assert.deepEqual(report.artifactsAfter, report.artifactsBefore);});
  await cleanup('observer', async () => {if (values['close-observer']) await observer?.close(); else observer?.socket.destroy();});
  await save();
}
console.log(JSON.stringify({status: report.status, checks: report.checks.length, report: path.join(directory, 'report.json')}));
if (report.status !== 'passed') process.exitCode = 1;
