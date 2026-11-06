// Actual Rolldown -> permanent Refresh client -> dedicated C ABI, test hooks OFF.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile, copyFile, chmod, cp} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createNativeDevEngine} from '../../../scripts/dev-engine.mjs';
import {buildNativeRefreshBootstrap, nativeRefreshTransform} from '../../../scripts/refresh-transform.mjs';
import {nodeByID, textOf} from '../../host.mjs';
import {screenSource} from './fixtures.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const directory = path.join(root, 'build/refresh', `ingress-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(directory, {recursive: true});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = {schemaVersion: 1, status: 'running', directory, checks: [], artifacts: [], errors: []};
const save = async (name, data) => {
  await writeFile(path.join(directory, name), data);
  report.artifacts.push({name, sha256: hash(data)});
};
class Queue {
  items = []; waiters = [];
  put(value) {const waiter = this.waiters.shift(); waiter ? waiter(value) : this.items.push(value);}
  async take() {
    if (this.items.length) return this.items.shift();
    let callback, timer;
    try {return await new Promise((resolve, reject) => {
      callback = resolve; this.waiters.push(resolve);
      timer = setTimeout(() => reject(Error('compiler/driver response timeout')), 15000);
    });} finally {clearTimeout(timer); this.waiters = this.waiters.filter(value => value !== callback);}
  }
}
let engine, child, childExit, reader;
let stderr = '';
const boot = new Queue(), updates = new Queue(), replies = new Queue();
const project = path.join(directory, 'project'), application = path.join(project, 'application');
const renderer = path.join(root, 'js/renderer.js');
globalThis.__refreshFixtureRenderer = renderer;
const clientId = 'native-ingress-gate';
const sessionId = '31'.repeat(16);
let generation, sequence = 0, revision = 'initial';
let binary, frameworkLibrary;
const request = async value => {
  assert.ok(child && child.exitCode === null, 'driver alive');
  child.stdin.write(`${JSON.stringify(value)}\n`);
  return JSON.parse(await replies.take());
};
const protocol = async (method, params = {}) => {
  const response = await request({id: 1, method, params});
  if (response.error) throw Error(JSON.stringify(response.error));
  return response.result;
};
const observe = () => protocol('app.event', {operation: 'inspect'});
async function check({count, input, label, preserved = true}) {
  const observed = await observe();
  if (count !== undefined) assert.equal(textOf(nodeByID(observed.tree, 'count')), String(count));
  if (input !== undefined) assert.equal(nodeByID(observed.tree, 'input').props.value, input);
  if (label !== undefined) assert.equal(textOf(nodeByID(observed.tree, 'label')), label);
  assert.equal(observed.sameMarker, preserved); assert.equal(observed.sameNode, preserved);
  assert.equal(observed.sameReact, true); assert.equal(observed.sameRenderer, true); assert.equal(observed.sameServices, true);
  assert.equal(observed.refresh.renderers, 1); assert.equal(observed.refresh.mountedRoots, 1);
  assert.equal((await request({method: 'dev.status'})).result.generation, generation);
  return observed;
}
async function compilerEvent() {
  for (;;) {
    const value = await updates.take();
    if (value instanceof Error) return value;
    const update = value.updates.find(item => item.clientId === clientId)?.update;
    if (update && update.type !== 'Noop') return update;
  }
}
async function deliver(source, target, expected = 'applied') {
  const envelope = {method: 'dev.enqueue', generation: String(generation), sessionId,
    sequence: String(++sequence), baseRevision: revision, targetRevision: target,
    payloadSha256: hash(source), payloadHex: Buffer.from(source).toString('hex')};
  await save(`${sequence}-payload.js`, source);
  await save(`${sequence}-envelope.json`, JSON.stringify({...envelope, payloadHex: '<retained in payload artifact>'}, null, 2));
  const queued = await request(envelope); assert.equal(queued.result?.status, 'queued', JSON.stringify(queued));
  const outcome = await request({method: 'dev.drain'});
  await save(`${sequence}-ack.json`, JSON.stringify(outcome, null, 2));
  assert.equal(outcome.result?.status, expected, JSON.stringify(outcome));
  if (expected === 'applied') revision = target;
  assert.equal(outcome.result.appliedRevision, revision);
  return outcome.result;
}
async function edit(file, source, expected = 'applied') {
  await engine.ensureCurrentBuildFinish();
  await writeFile(path.join(application, file), source);
  const patch = await compilerEvent();
  if (patch instanceof Error) throw patch;
  assert.equal(patch.type, 'Patch');
  await save(`${sequence + 1}-compiler-patch.json`, JSON.stringify(patch, null, 2));
  await save(`${sequence + 1}-compiler.map`, patch.sourcemap);
  const metadata = {schemaVersion: 1, sequence: sequence + 1, changedIds: patch.changedIds};
  const result = await deliver(`${patch.code}\nglobalThis.__nhApplyDevUpdate(${JSON.stringify(metadata)});`, `revision-${sequence + 1}`, expected);
  // Transport delivery is distinct from successful Refresh/native mount ACK.
  await engine.notifyPayloadDelivered(patch.filename);
  return result;
}
try {
  const originalBinary = process.env.NH_DEV_DRIVER || path.join(root, 'build/dev-ingress-1-0/native-host-dev-driver');
  const cache = await readFile(path.join(path.dirname(originalBinary), 'CMakeCache.txt'), 'utf8');
  const framework = process.env.NH_HERMES_FRAMEWORK || cache.match(/^HERMES_FRAMEWORK:PATH=(.*)$/m)?.[1];
  assert.ok(framework, 'matched framework path available');
  const privateFrameworkRoot = path.join(directory, 'frameworks');
  await mkdir(privateFrameworkRoot, {recursive: true});
  await cp(framework, path.join(privateFrameworkRoot, 'hermesvm.framework'), {recursive: true});
  frameworkLibrary = path.join(privateFrameworkRoot, 'hermesvm.framework/hermesvm');
  binary = path.join(directory, 'native-host-dev-driver');
  await copyFile(originalBinary, binary); await chmod(binary, 0o755);
  report.binarySha256Before = hash(await readFile(binary));
  report.frameworkSha256Before = hash(await readFile(frameworkLibrary));
  report.sourceHashes = {};
  for (const name of ['runtime/Host.cpp', 'runtime/host.h', 'runtime/dev/HostMethods.inc', 'runtime/dev/Integrity.h',
    'js/dev/refresh-client.js', 'js/dev/renderer-bootstrap.js', 'scripts/dev-engine.mjs', 'scripts/refresh-transform.mjs',
    'testing/refresh/react/fixtures.mjs', 'testing/refresh/react/ingress.mjs']) report.sourceHashes[name] = hash(await readFile(path.join(root, name)));
  await mkdir(application, {recursive: true});
  await writeFile(path.join(application, 'Screen.jsx'), screenSource());
  await writeFile(path.join(application, 'value.js'), 'export const suffix="one";\n');
  const entry = `import React from 'react';import * as Native from ${JSON.stringify(renderer)};
import * as Services from ${JSON.stringify(path.join(root, 'js/services.js'))};
import {attachRefreshRenderer} from ${JSON.stringify(path.join(root, 'js/dev/renderer-bootstrap.js'))};
import Screen from './application/Screen.jsx';
globalThis.__testEffects=[];attachRefreshRenderer(Native.reconciler);
const originalReact=React,originalFlush=__nhFlushMount,originalServices=__nhServiceEvent;
let originalMarker,originalNode,echoResult=null,messages=[],subscription;
globalThis.__nhDispatch=(method,params)=>{
 if(method!=='app.event')throw Error('unsupported fixture method');
 if(params.operation==='capture'){originalMarker=__testMarker;originalNode=__testInputRef;return null;}
 if(params.operation==='seed-services'){Services.echo('across-ingress',50).promise.then(value=>echoResult=value);subscription=Services.subscribe(value=>messages.push(value));return null;}
 if(params.operation==='publish'){subscription.publish('survived');return null;}
 if(params.operation==='unsubscribe'){subscription.unsubscribe();return null;}
 if(params.operation==='inspect')return {tree:Native.snapshot(),sameMarker:__testMarker===originalMarker,sameNode:__testInputRef===originalNode,
   sameReact:__testScreenReact===originalReact,sameRenderer:__nhFlushMount===originalFlush,sameServices:__nhServiceEvent===originalServices,
   refresh:__nhDevRefreshState(),effects:__testEffects,echoResult,messages,serviceStatus:Services.serviceStatus()};
 return Native.dispatchEvent(params);
};
Native.render(React.createElement(Screen));`;
  await writeFile(path.join(project, 'entry.js'), entry);
  const runtime = await buildNativeRefreshBootstrap({clientId}); await save('bootstrap.js', runtime);
  engine = await createNativeDevEngine({root: project, entry: path.join(project, 'entry.js'), runtime,
    transform: {define: {'process.env.NODE_ENV': '"development"', __NH_TEST_HOOKS__: 'false'}},
    plugins: [nativeRefreshTransform({root: project})], onOutput: value => boot.put(value), onHmrUpdates: value => updates.put(value)});
  await engine.run(); const built = await boot.take(); if (built instanceof Error) throw built;
  const initial = built.output.find(value => value.type === 'chunk').code; await save('initial.js', initial);
  child = spawn(binary, ['--bundle', path.join(directory, 'initial.js')], {
    env: {...process.env, DYLD_FRAMEWORK_PATH: privateFrameworkRoot, DYLD_PRINT_LIBRARIES: '1'}, stdio: ['pipe', 'pipe', 'pipe']});
  child.stderr.on('data', bytes => {stderr += bytes;});
  reader = createInterface({input: child.stdout});reader.on('line', line => replies.put(line));
  childExit = new Promise((resolve, reject) => {child.on('error', reject);child.on('exit', (code, signal) => resolve({code, signal}));});
  report.runtime = await protocol('session.describe'); assert.equal(report.runtime.testHooks, false);
  const status = (await request({method: 'dev.status'})).result; generation = status.generation;
  assert.equal(status.initialBundleSha256, hash(initial));
  const opened = await request({method: 'dev.open', generation: String(generation), sessionId, initialRevision: revision, initialBundleSha256: hash(initial)});
  assert.equal(opened.result?.opened, true, JSON.stringify(opened));
  const forbidden = await request({method: 'runtime.eval', params: {source: 'throw Error("must not execute")'}});
  assert.match(forbidden.error.message, /test build/);report.checks.push('dedicated-ingress-with-test-eval-disabled');
  assert.ok(stderr.includes(frameworkLibrary) || stderr.includes(path.join(privateFrameworkRoot, 'hermesvm.framework/Versions/1/hermesvm')), 'dyld loaded private pinned framework');
  await protocol('app.event', {operation: 'capture'}); await engine.registerClient(clientId);
  let tree = (await observe()).tree;
  await protocol('app.event', {nodeId: nodeByID(tree, 'button').id, event: 'press'});
  await protocol('app.event', {nodeId: nodeByID(tree, 'input').id, event: 'changeText', payload: {text: 'typed', eventCount: 1}});
  await protocol('app.event', {operation: 'seed-services'});
  await check({count: 1, input: 'typed', label: 'initial:one'});
  await edit('Screen.jsx', screenSource({label: 'body', step: 10}));
  const body = await check({count: 1, input: 'typed', label: 'body:one'});
  assert.deepEqual(body.effects, ['setup:initial', 'cleanup:initial', 'setup:body']);
  tree = body.tree;await protocol('app.event', {nodeId: nodeByID(tree, 'button').id, event: 'press'});
  await check({count: 11, input: 'typed'});report.checks.push('actual-component-body-state-ref-handler-effect-native-tree');
  await protocol('app.event', {operation: 'publish'});
  const deadline = Date.now() + 3000;let services;
  do {services = await observe();if (services.echoResult === 'across-ingress' && services.messages.includes('survived')) break;await new Promise(resolve => setTimeout(resolve, 10));} while (Date.now() < deadline);
  assert.equal(services.echoResult, 'across-ingress');assert.deepEqual(services.messages, ['survived']);
  await protocol('app.event', {operation: 'unsubscribe'});report.checks.push('rust-request-and-subscription-survive');
  await edit('value.js', 'export const suffix="two";\n');await check({count: 11, input: 'typed', label: 'body:two'});
  report.checks.push('actual-import-update-retains-identity');
  await deliver('globalThis.__mutationBeforeSyntax=1;function broken( {', 'bad-native-prepare', 'rejected');
  await check({count: 11, input: 'typed', label: 'body:two'});report.checks.push('native-prepare-rejection-preserves-live-react');
  await engine.ensureCurrentBuildFinish();await writeFile(path.join(application, 'Screen.jsx'), 'export default function Screen( {');
  const error = await compilerEvent();assert.ok(error instanceof Error);await save('compiler-error.txt', String(error));
  await check({count: 11, input: 'typed', label: 'body:two'});
  await edit('Screen.jsx', screenSource({label: 'fixed', step: 10}));await check({count: 11, input: 'typed', label: 'fixed:two'});
  report.checks.push('compiler-error-fix-after-native-sequence-gap');
  await edit('Screen.jsx', screenSource({label: 'hook', extraHook: true}));await check({count: 0, input: 'seed', label: 'hook:two', preserved: false});
  report.checks.push('hook-signature-explicit-remount');
  await edit('Screen.jsx', screenSource({label: 'mixed', extraHook: true, mixed: true}), 'reload-required');
  const poisoned = (await request({method: 'dev.status'})).result;assert.equal(poisoned.reloadRequired, true);
  const blocked = await request({method: 'app.event', params: {operation: 'inspect'}});assert.equal(blocked.error.code, 'DEV_RELOAD_REQUIRED');
  report.checks.push('real-mixed-export-failure-poisons-native-session');
  report.finalNativeStatus = poisoned;
  child.stdin.end();const exit = await childExit;assert.equal(exit.code, 0);child = null;
  await engine.close();engine = null;
  report.binarySha256After = hash(await readFile(binary));report.frameworkSha256After = hash(await readFile(frameworkLibrary));
  assert.equal(report.binarySha256After, report.binarySha256Before);assert.equal(report.frameworkSha256After, report.frameworkSha256Before);
  report.status = 'passed';
} catch (error) {report.status = 'failed';report.errors.push({message: String(error), stack: error.stack});process.exitCode = 1;}
finally {
  if (child) {child.kill('SIGTERM');await childExit;}
  reader?.close();
  try {await engine?.close();} catch (error) {report.status = 'failed';report.errors.push({phase: 'cleanup', message: String(error)});process.exitCode = 1;}
  await writeFile(path.join(directory, 'driver-stderr.txt'), stderr);
  report.finishedAt = new Date().toISOString();await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({status: report.status, checks: report.checks.length, report: path.join(directory, 'report.json'), errors: report.errors}));
}
