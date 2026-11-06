import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile, copyFile, chmod, realpath, readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createNativeDevEngine, nativeCommonRuntime} from '../../../scripts/dev-engine.mjs';
import {dev} from 'rolldown/experimental';

const prototype = fileURLToPath(new URL('../../../', import.meta.url));
const runDirectory = path.join(prototype, 'build/refresh', new Date().toISOString().replaceAll(':', '-'));
const project = path.join(runDirectory, 'project');
await mkdir(project, {recursive: true});
const sha = value => createHash('sha256').update(value).digest('hex');
const report = {schemaVersion: 1, scope: 'NON-REACT compiler/Hermes feasibility only',
  startedAt: new Date().toISOString(), runDirectory, samples: [], errors: [], artifacts: [], negativeChecks: [], ignoredCompilerEvents: [],
  earlierAttempts: [
    {configuration: 'output.format=iife', result: 'DevEngine rejected: devMode only supports esm'},
    {configuration: 'esm with unadapted common runtime; lazy:false', result: 'Hermes rejected browser import() in loadLazyChunk: Invalid expression encountered'},
  ]};
const save = async (name, bytes) => {
  await writeFile(path.join(runDirectory, name), bytes);
  report.artifacts.push({name, sha256: sha(bytes), byteLength: Buffer.byteLength(bytes)});
};
class Queue {
  items = []; waiters = [];
  put(value) { const next = this.waiters.shift(); if (next) next(value); else this.items.push(value); }
  async take() {
    if (this.items.length) return this.items.shift();
    let timer, receive;
    try { return await new Promise((resolve, reject) => {
      receive = value => resolve(value); this.waiters.push(receive);
      timer = setTimeout(() => reject(new Error('Compiler event timeout')), 15000);
    }); } finally { clearTimeout(timer); this.waiters = this.waiters.filter(x => x !== receive); }
  }
}
class Rpc {
  pending = new Map(); sequence = 0; stderr = ''; failure = null; closed = false;
  shutdownRequested = false; exit = null; forcedKill = false;
  constructor(binary, bundle) {
    this.child = spawn(binary, ['--bundle', bundle], {stdio: ['pipe', 'pipe', 'pipe']});
    this.child.stderr.on('data', b => this.stderr += b);
    this.child.stdin.on('error', error => this.fail(error));
    createInterface({input: this.child.stdout}).on('line', line => {
      let item; try { item = JSON.parse(line); } catch { this.fail(new Error(line)); return; }
      const waiter = this.pending.get(item.id);
      if (!waiter) { this.fail(new Error(`Unexpected response: ${line}`)); return; }
      this.pending.delete(item.id); clearTimeout(waiter.timer);
      item.error ? waiter.reject(new Error(JSON.stringify(item.error))) : waiter.resolve(item.result);
    });
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', (code, signal) => {
      this.exit = {code, signal};
      if (!this.shutdownRequested || code !== 0 || signal) this.fail(new Error(`Host exited ${code ?? signal}: ${this.stderr}`));
    });
    this.child.on('close', () => { this.closed = true; });
  }
  fail(error) { this.failure ??= error; for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); }
  call(method, params = {}) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.child.exitCode !== null) return Promise.reject(new Error(this.stderr));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error(`Host timeout: ${method}`)); this.child.kill('SIGKILL');
      }, 10000);
      this.pending.set(id, {resolve, reject, timer});
      this.child.stdin.write(`${JSON.stringify({id, method, params})}\n`);
    });
  }
  evaluate(source) { return this.call('runtime.eval', {source}); }
  async close() {
    this.shutdownRequested = true;
    if (!this.closed) {
      const done = new Promise(resolve => this.child.once('close', resolve));
      this.child.stdin.end();
      const timer = setTimeout(() => {this.forcedKill = true; this.child.kill('SIGKILL');}, 2000);
      try { await done; } finally { clearTimeout(timer); }
    }
    if (this.failure) throw this.failure;
    if (this.forcedKill || !this.exit || this.exit.code !== 0 || this.exit.signal) throw new Error(`Unclean host teardown: ${JSON.stringify(this.exit)}`);
    if (this.stderr.trim()) throw new Error(`Unexpected native host stderr: ${this.stderr}`);
  }
}
let engine, host;
const fullOutputs = new Queue(), updates = new Queue();
async function nextClientUpdate() {
  for (let i = 0; i < 20; i++) {
    const event = await updates.take();
    if (event instanceof Error) return event;
    if (event.updates.some(x => x.clientId === 'native-compiler-gate' && x.update.type !== 'Noop')) return event;
    report.ignoredCompilerEvents.push(event);
  }
  throw new Error('Too many irrelevant compiler events');
}
try {
  const packageJSON = JSON.parse(await readFile(path.join(prototype, 'node_modules/rolldown/package.json')));
  assert.equal(packageJSON.version, '1.3.0');
  const common = await nativeCommonRuntime();
  report.compiler = {version: packageJSON.version, node: process.version,
    commonRuntimeOriginalSha256: common.originalSha256, commonRuntimeAdaptedSha256: common.adaptedSha256,
    options: {format: 'esm', platform: 'neutral', sourcemap: true, lazy: false, rebuildStrategy: 'never'}};
  const binary = path.join(runDirectory, 'native-host');
  await copyFile(process.env.NH_HOST_BINARY || path.join(prototype, 'build/headless/native-host'), binary);
  await chmod(binary, 0o755);
  report.binarySha256Before = sha(await readFile(binary));
  const runtime = await readFile(new URL('./gate-runtime.js', import.meta.url), 'utf8');
  report.clientSha256 = sha(runtime);
  report.sources = {};
  for (const relative of ['scripts/dev-engine.mjs', 'testing/refresh/compiler/run.mjs', 'testing/refresh/compiler/gate-runtime.js',
    'node_modules/rolldown/dist/experimental-index.mjs', 'node_modules/rolldown/dist/shared/binding-CKhbEBcw.d.mts']) {
    report.sources[relative] = sha(await readFile(path.join(prototype, relative)));
  }
  const linkedLibraries = execFileSync('otool', ['-L', binary], {encoding: 'utf8'});
  const linkedHermes = linkedLibraries.match(/@rpath\/[^\s]+\/hermesvm/);
  assert.ok(linkedHermes, 'Expected the macOS embedded Hermes framework');
  const loadCommands = execFileSync('otool', ['-l', binary], {encoding: 'utf8'});
  const rpath = loadCommands.match(/cmd LC_RPATH\s+cmdsize \d+\s+path ([^\n]+) \(offset \d+\)/);
  assert.ok(rpath, 'Expected the embedded host framework rpath');
  report.hermesLibrary = {path: await realpath(path.join(rpath[1], linkedHermes[0].slice('@rpath/'.length)))};
  report.hermesLibrary.sha256Before = sha(await readFile(report.hermesLibrary.path));
  await writeFile(path.join(project, 'entry.js'), 'import {read} from "./app.js"; globalThis.__gateResult = read();\n');
  await writeFile(path.join(project, 'app.js'), 'import {value} from "./value.js"; export function read() { return value; }\n');
  await writeFile(path.join(project, 'value.js'), 'export const value = 1;\n');
  await writeFile(path.join(project, 'extra.js'), 'export const extra = 5;\n');
  await writeFile(path.join(project, 'legacy.cjs'), 'module.exports = {multiply: value => value * 3};\n');
  try {
    const rejected = await dev({cwd: project, input: path.join(project, 'entry.js'), experimental: {devMode: {implement: runtime, lazy: false}}}, {format: 'iife'}, {watch: {enabled: false}});
    await rejected.close();
    throw new Error('Expected iife devMode rejection');
  } catch (error) {
    assert.match(String(error), /only supports.*esm/s);
    report.negativeChecks.push({name: 'iife-rejected-by-compiler', error: String(error)});
  }
  engine = await createNativeDevEngine({root: project, entry: path.join(project, 'entry.js'), runtime,
    onOutput: output => fullOutputs.put(output), onHmrUpdates: value => updates.put(value),
    onAdditionalAssets: value => report.errors.push({unexpectedAdditionalAssets: String(value)})});
  await engine.run();
  const initial = await fullOutputs.take();
  if (initial instanceof Error) throw initial;
  const chunks = initial.output.filter(x => x.type === 'chunk');
  assert.equal(chunks.length, 1, 'Single script initial output required');
  await save('initial.js', chunks[0].code);
  await save('initial.js.map', JSON.stringify(chunks[0].map));
  host = new Rpc(binary, path.join(runDirectory, 'initial.js'));
  report.runtime = await host.call('session.describe');
  assert.equal(await host.evaluate('globalThis.__gateResult'), 1);
  assert.equal(await host.evaluate('globalThis.__gateBootstrapCount'), 1);
  // Reproduce the parser incompatibility from the original published source;
  // evaluateJavaScript parses the whole program before running any statements.
  const rawOutputs = new Queue();
  const rawEngine = await dev({cwd: project, input: path.join(project, 'entry.js'),
    platform: 'neutral', experimental: {devMode: {implement: runtime, lazy: false}}},
    {format: 'esm'}, {watch: {enabled: false, skipWrite: true}, onOutput: value => rawOutputs.put(value)});
  try {
    await rawEngine.run();
    const raw = await rawOutputs.take();
    if (raw instanceof Error) throw raw;
    const rawCode = raw.output.find(x => x.type === 'chunk').code;
    await save('unsupported-browser-runtime.js', rawCode);
    await assert.rejects(host.evaluate(rawCode), error => {
      assert.match(String(error), /Invalid expression/);
      report.negativeChecks.push({name: 'unadapted-runtime-rejected-by-Hermes', error: String(error)});
      return true;
    });
    assert.equal(await host.evaluate('globalThis.__gateBootstrapCount'), 1);
    assert.equal(await host.evaluate('globalThis.__gateResult'), 1);
  } finally { await rawEngine.close(); }
  await engine.registerClient('native-compiler-gate');
  const cases = [
    ['changed-export', 'value.js', 'export const value = 2;\n', 2],
    ['add-import', 'app.js', 'import {value} from "./value.js"; import {extra} from "./extra.js"; export function read(){return value + extra;}\n', 7],
    ['remove-import', 'app.js', 'import {extra} from "./extra.js"; export function read(){return extra;}\n', 5],
    ['commonjs-import', 'app.js', 'import {extra} from "./extra.js"; import legacy from "./legacy.cjs"; export function read(){return legacy.multiply(extra);}\n', 15],
    ['commonjs-update', 'legacy.cjs', 'module.exports = {multiply: value => value * 4};\n', 20],
    ['repeat-one', 'extra.js', 'export const extra = 6;\n', 24],
    ['repeat-two', 'extra.js', 'export const extra = 7;\n', 28],
  ];
  for (const [name, file, source, expected] of cases) {
    await engine.ensureCurrentBuildFinish();
    await writeFile(path.join(project, file), source);
    const event = await nextClientUpdate();
    if (event instanceof Error) throw event;
    const own = event.updates.filter(x => x.clientId === 'native-compiler-gate');
    assert.equal(own.length, 1);
    const update = own[0].update;
    await save(`${name}.json`, JSON.stringify(event, null, 2));
    assert.equal(update.type, 'Patch', name);
    await save(`${name}.js`, update.code);
    await save(`${name}.js.map`, update.sourcemap);
    assert.ok(JSON.parse(update.sourcemap).sourcesContent.includes(source), 'Patch map must include edited source');
    // Evaluate registration payload first, then execute the gate's propagation.
    // Server shipped-map acknowledgment is deliberately after evaluation.
    await host.evaluate(update.code);
    await engine.notifyPayloadDelivered(update.filename);
    const result = await host.evaluate(`globalThis.__gateApply(${JSON.stringify(update.changedIds)}, ${update.seq})`);
    assert.equal(result.result, expected, name);
    assert.equal(result.bootstrapCount, 1, 'Native runtime bootstrap must not rerun');
    report.samples.push({name, file, sourceSha256: sha(source), expected, updateSequence: update.seq, result});
  }
  await engine.ensureCurrentBuildFinish();
  await writeFile(path.join(project, 'extra.js'), 'export const extra = ;\n');
  const compileFailure = await nextClientUpdate();
  assert.ok(compileFailure instanceof Error, 'Invalid source must produce a compiler error');
  report.negativeChecks.push({name: 'syntax-error-leaves-live-state', error: String(compileFailure)});
  assert.equal(await host.evaluate('globalThis.__gateResult'), 28);
  await engine.ensureCurrentBuildFinish();
  await writeFile(path.join(project, 'extra.js'), 'export const extra = 8;\n');
  const recovery = await nextClientUpdate();
  if (recovery instanceof Error) throw recovery;
  await save('syntax-fix.json', JSON.stringify(recovery, null, 2));
  const fix = recovery.updates.find(x => x.clientId === 'native-compiler-gate').update;
  assert.equal(fix.type, 'Patch');
  await save('syntax-fix.js', fix.code);
  await save('syntax-fix.js.map', fix.sourcemap);
  await host.evaluate(fix.code);
  await engine.notifyPayloadDelivered(fix.filename);
  const fixedResult = await host.evaluate(`globalThis.__gateApply(${JSON.stringify(fix.changedIds)}, ${fix.seq})`);
  assert.equal(fixedResult.result, 32);
  assert.equal(fixedResult.bootstrapCount, 1);
  report.samples.push({name: 'syntax-error-fixed', expected: 32, updateSequence: fix.seq, result: fixedResult});
  const state = await engine.getBundleState();
  assert.equal(state.lastBuildErrored, false);
  const pumped = await host.call('runtime.pump');
  assert.deepEqual(pumped.errors, []);
  report.finalCompilerState = state;
  report.binarySha256After = sha(await readFile(binary));
  assert.equal(report.binarySha256Before, report.binarySha256After);
  report.hermesLibrary.sha256After = sha(await readFile(report.hermesLibrary.path));
  assert.equal(report.hermesLibrary.sha256Before, report.hermesLibrary.sha256After);
  assert.deepEqual(report.errors, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.errors.push({message: String(error), stack: error.stack}); process.exitCode = 1;
} finally {
  // Explicit regression fault: the otherwise successful gate must still fail
  // its receipt when the native process dies during teardown.
  if (process.env.NH_COMPILER_GATE_CLEANUP_FAULT === 'kill-host' && host && !host.closed) {
    report.cleanupFaultInjected = 'SIGKILL'; host.child.kill('SIGKILL');
  }
  const cleanup = await Promise.allSettled([
    Promise.resolve().then(() => host?.close()),
    Promise.resolve().then(() => engine?.close()),
  ]);
  cleanup.forEach((result, index) => {
    if (result.status === 'rejected') report.errors.push({
      phase: index === 0 ? 'host-cleanup' : 'compiler-cleanup',
      message: String(result.reason), stack: result.reason?.stack,
    });
  });
  if (report.errors.length) { report.status = 'failed'; process.exitCode = 1; }
  report.hostStderr = host?.stderr;
  report.finishedAt = new Date().toISOString();
  report.priorRuns = [];
  for (const name of await readdir(path.dirname(runDirectory))) {
    if (name === path.basename(runDirectory)) continue;
    try {
      const previous = JSON.parse(await readFile(path.join(path.dirname(runDirectory), name, 'report.json')));
      report.priorRuns.push({directory: name, status: previous.status, samples: previous.samples?.length ?? previous.checks?.length ?? null, errors: previous.errors});
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
        report.errors.push({phase: 'prior-report-inventory', directory: name, message: String(error)});
        report.status = 'failed'; process.exitCode = 1;
      }
    }
  }
  await writeFile(path.join(runDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({status: report.status, report: path.join(runDirectory, 'report.json'), samples: report.samples.length, errors: report.errors}));
}
