import {spawn, spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {cp, copyFile, mkdir, readFile, writeFile, readdir, realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {validateHermes} from '../benchmarking/validate-hermes.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const reference = path.join(root, 'build/reference');
const dependencies = path.join(root, 'node_modules');
const run = path.join(root, 'build/tooling-benchmark', new Date().toISOString().replaceAll(':', '-'));
const project = path.join(run, 'project');
const source = path.join(project, 'js/app.jsx');
const sourceBinary = path.join(root, 'build/headless/native-host');
const runtimeDir = path.join(run, 'native');
const binary = path.join(runtimeDir, 'native-host');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const require = createRequire(path.join(root, 'package.json'));
const referenceRequire = createRequire(path.join(reference, 'package.json'));
const report = {schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(),
  scope: 'same-candidate-app full development JS bundle and external source map generation',
  settings: {warmupsPerEngine: 3, warmSamplesPerEngine: 20, freshSamplesPerCondition: 5,
    mode: 'development', minify: false, externalSourceMap: true, sourcesContent: true,
    fullBundle: true, lazy: false, inlineRequires: false, metroPlatform: 'android', rolldownPlatform: 'neutral',
    metroMaxWorkers: 4, metroWatchman: false, rolldownRayonThreads: 4, rolldownBuildDelayMs: 35,
    threadCaveat: 'Metro process workers and Rolldown Rayon threads are different concurrency models; both explicitly bounded to four.',
    cacheCaveat: 'OS caches are uncontrolled. Metro cold conditions use unique empty transform/file-map cache directories; fresh-warm retains them. Rolldown has no configured persistent transform cache.'},
  versions: {node: process.version, metro: referenceRequire('metro/package.json').version,
    rolldown: require('rolldown/package.json').version, react: require('react/package.json').version,
    reconciler: require('react-reconciler/package.json').version},
  machine: {platform: os.platform(), arch: os.arch(), release: os.release(), cpus: os.availableParallelism(), cpuModel: os.cpus()[0]?.model},
  samples: [], failures: [],
  limitations: ['Not RN Fast Refresh, state-preserving HMR, native build, simulator, browser, or edit-to-visible performance.',
    'Tiny candidate app graph including development scenarios; results cannot be generalized to RNTester or larger applications.',
    'Metro includes its module loader and Babel helpers; Rolldown includes its own runtime. Source app and dependency versions are matched, generated artifacts are not byte-equivalent.',
    'Warm Metro path includes loopback HTTP transfer for bundle and source map; Rolldown writes files directly. Both end at a complete written artifact pair.',
    'Five fresh-process samples are too few for a stable tail estimate; their p95 is effectively the observed maximum.']};
await mkdir(project, {recursive: true});
await mkdir(runtimeDir, {recursive: true});
// The surrounding development task can rebuild its host. Pin our executable
// and its actual non-system runtime library before launching any samples.
const checked = (command, args) => {
  const result = spawnSync(command, args, {encoding: 'utf8'});
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`);
  return result.stdout;
};
const originalBinaryHash = hash(await readFile(sourceBinary));
await copyFile(sourceBinary, binary);
assert.equal(hash(await readFile(binary)), originalBinaryHash, 'Executable changed during snapshot copy');
const loadCommands = checked('otool', ['-l', binary]);
const rpath = loadCommands.match(/cmd LC_RPATH\s+cmdsize \d+\s+path (.+) \(offset/)[1];
const framework = path.join(rpath, 'hermesvm.framework');
const originalHermes = await realpath(path.join(framework, 'hermesvm'));
const originalHermesHash = hash(await readFile(originalHermes));
await cp(framework, path.join(runtimeDir, 'hermesvm.framework'), {recursive: true, verbatimSymlinks: true});
const pinnedHermes = await realpath(path.join(runtimeDir, 'hermesvm.framework/hermesvm'));
assert.ok(pinnedHermes.startsWith(runtimeDir + path.sep));
assert.equal(hash(await readFile(pinnedHermes)), originalHermesHash);
checked('install_name_tool', ['-rpath', rpath, runtimeDir, binary]);
checked('codesign', ['--force', '--sign', '-', binary]);
report.pinnedRuntime = {binary, originalBinaryHash, pinnedHermes, hermesSha256: originalHermesHash,
  originalHermes, loadCommands: checked('otool', ['-L', binary]), rpath: runtimeDir,
  note: 'Copied executable and Hermes framework; only copied executable rpath/signature changed. System dylibs remain supplied by macOS.'};
report.priorAttempts = [];
for (const directory of await readdir(path.dirname(run))) {
  const previous = path.join(path.dirname(run), directory, 'report.json');
  if (previous === path.join(run, 'report.json')) continue;
  try { const data = JSON.parse(await readFile(previous, 'utf8')); report.priorAttempts.push({report: previous, status: data.status, failures: data.failures, samples: data.samples.length}); } catch {}
}
await cp(path.join(root, 'js'), path.join(project, 'js'), {recursive: true});
const original = await readFile(source, 'utf8');
const heading = 'Native host prototype';
if (original.split(heading).length !== 2) throw new Error('Expected exactly one controlled heading in app source');
report.sourceFiles = {};
for (const name of (await readdir(path.join(project, 'js'))).sort()) report.sourceFiles[`js/${name}`] = hash(await readFile(path.join(project, 'js', name)));
report.binarySha256 = hash(await readFile(binary));
const persist = () => writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2) + '\n');
await persist();

class Worker {
  queue = []; waiters = []; stderr = ''; closed = false;
  constructor(engine, mode, cache, output) {
    this.started = performance.now();
    this.child = spawn(process.execPath, [path.join(root, 'benchmarking/worker.mjs'), JSON.stringify({engine, mode, cache, output, project, reference, dependencies})],
      {cwd: root, env: {...process.env, RAYON_NUM_THREADS: '4'}, stdio: ['pipe', 'pipe', 'pipe']});
    this.child.once('exit', () => { this.exitedAt = performance.now(); });
    this.exited = new Promise(resolve => this.child.once('close', (code, signal) => { this.closed = true; resolve({code, signal}); }));
    this.child.stderr.on('data', data => { this.stderr += data; });
    this.child.once('error', error => this.push({type: 'failure', error: String(error)}));
    this.child.once('exit', (code, signal) => this.push({type: 'exit', code, signal}));
    createInterface({input: this.child.stdout}).on('line', line => {
      try { this.push({...JSON.parse(line), receivedAt: performance.now()}); }
      catch { this.push({type: 'failure', error: `Non-protocol worker stdout: ${line}`}); }
    });
  }
  push(message) { if (message.type === 'failure') this.failure = message.error; const waiter = this.waiters.shift(); if (waiter) waiter(message); else this.queue.push(message); }
  async next() {
    if (this.queue.length) return this.queue.shift();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Worker timed out: ${this.stderr}`)), 90000);
      this.waiters.push(message => { clearTimeout(timer); resolve(message); });
    });
  }
  async until(type) {
    for (;;) {
      const message = await this.next();
      if (message.type === type) return message;
      if (message.type === 'failure' || message.type === 'exit') throw new Error(`Worker ${JSON.stringify(message)} ${this.stderr}`);
      if (message.type === 'change') this.change = message.receivedAt;
      else throw new Error(`Unexpected worker event: ${JSON.stringify(message)}`);
    }
  }
  async stop(warm) {
    if (!this.closed && warm) this.child.stdin.end('quit\n');
    const kill = setTimeout(() => this.child.kill('SIGKILL'), 15000);
    const result = await this.exited; clearTimeout(kill);
    if (result.code !== 0) throw new Error(`Worker shutdown ${JSON.stringify(result)} ${this.failure || ''} ${this.stderr}`);
  }
}
let golden;
async function validate(artifact, label, sample) {
  const [bundle, map] = await Promise.all([readFile(artifact.bundleFile), readFile(artifact.mapFile)]);
  const decoded = JSON.parse(map);
  assert.equal(decoded.version, 3);
  // Metro emits a valid indexed v3 map; Rolldown emits a flat v3 map.
  const contents = value => [...(value.sourcesContent || []), ...(value.sections || []).flatMap(section => contents(section.map))];
  assert.ok(contents(decoded).some(content => content === original.replace(heading, label)), 'Source map must contain the exact edited app source');
  const result = await validateHermes(binary, artifact.bundleFile, label);
  if (golden) assert.deepEqual(result.observations, golden.observations, 'Semantic output differs across tools or edits');
  else { golden = result; await writeFile(path.join(run, 'semantic-golden.json'), JSON.stringify(result, null, 2) + '\n'); report.runtime = result.identity; }
  sample.artifacts = {bundleSha256: hash(bundle), mapSha256: hash(map), bundleBytes: bundle.length, mapBytes: map.length};
  sample.semanticValidation = 'passed';
}

try {
  for (const engine of ['metro', 'rolldown']) {
    const output = path.join(run, 'artifacts', engine, 'validation');
    const worker = new Worker(engine, 'fresh', path.join(run, 'cache', 'metro-warm'), output);
    try {
      const artifact = await worker.until('built');
      const sample = {engine, phase: 'preflight', wallMs: artifact.receivedAt - worker.started, buildMs: artifact.durationMs};
      report.samples.push(sample); await validate(artifact, heading, sample);
    } finally { await worker.stop(false); await writeFile(path.join(output, 'worker.stderr.log'), worker.stderr); }
    await persist();
  }
  console.log('Both tool outputs passed identical Hermes semantic validation.');
  for (const engine of ['metro', 'rolldown']) {
    await writeFile(source, original);
    const output = path.join(run, 'artifacts', engine, 'warm');
    const worker = new Worker(engine, 'warm', path.join(run, 'cache', 'metro-warm'), output);
    try {
      const first = await worker.until('built');
      const initial = {engine, phase: 'watch-initial', wallMs: first.receivedAt - worker.started, buildMs: first.durationMs};
      report.samples.push(initial); await validate(first, heading, initial);
      for (let index = 0; index < 23; index++) {
        const label = `Tooling benchmark ${String(index).padStart(2, '0')}`;
        worker.child.stdin.write('arm\n'); await worker.until('armed'); worker.change = undefined;
        const started = performance.now();
        await writeFile(source, original.replace(heading, label));
        const artifact = await worker.until('built');
        const sample = {engine, phase: index < 3 ? 'warmup' : 'warm', index: index < 3 ? index : index - 3,
          label, sourceWriteToArtifactMs: artifact.receivedAt - started,
          watcherDetectionMs: worker.change === undefined ? null : worker.change - started,
          buildMs: artifact.durationMs};
        report.samples.push(sample); await validate(artifact, label, sample); await persist();
      }
    } finally { await worker.stop(true); await writeFile(path.join(output, 'worker.stderr.log'), worker.stderr); }
    console.log(`${engine}: 20 measured warm samples validated after 3 warmups.`);
  }
  await writeFile(source, original);
  for (const condition of ['fresh-warm-cache', 'fresh-empty-cache']) {
    // Rolldown has no configured persistent cache; don't duplicate its identical
    // condition and imply a disk-cache distinction that does not exist.
    for (const engine of condition === 'fresh-warm-cache' ? ['metro', 'rolldown'] : ['metro']) {
      for (let index = 0; index < 5; index++) {
        const output = path.join(run, 'artifacts', engine, `${condition}-${index}`);
        const cache = path.join(run, 'cache', condition === 'fresh-empty-cache' ? `empty-${index}` : 'metro-warm');
        const worker = new Worker(engine, 'fresh', cache, output);
        let sample;
        try {
          const artifact = await worker.until('built');
          sample = {engine, phase: condition, index, artifactReadyMs: artifact.receivedAt - worker.started, buildMs: artifact.durationMs};
          report.samples.push(sample); await validate(artifact, heading, sample);
        } finally { await worker.stop(false); await writeFile(path.join(output, 'worker.stderr.log'), worker.stderr); }
        sample.wallMs = worker.exitedAt - worker.started;
        await persist();
      }
    }
  }
  const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
  report.summary = [];
  for (const engine of ['metro', 'rolldown']) for (const phase of ['warm', 'fresh-warm-cache', 'fresh-empty-cache']) {
    const samples = report.samples.filter(s => s.engine === engine && s.phase === phase);
    if (!samples.length) continue;
    const values = samples.map(s => phase === 'warm' ? s.sourceWriteToArtifactMs : s.wallMs);
    report.summary.push({engine, phase, n: values.length, medianMs: percentile(values, .5), p95Ms: percentile(values, .95), minMs: Math.min(...values), maxMs: Math.max(...values)});
  }
  assert.equal(hash(await readFile(binary)), report.binarySha256, 'Pinned executable changed');
  assert.equal(hash(await readFile(pinnedHermes)), report.pinnedRuntime.hermesSha256, 'Pinned Hermes changed');
  report.pinnedRuntime.hashesUnchangedAfterRun = true;
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failures.push({message: error.message, stack: error.stack}); process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await persist();
  console.log(`Tooling benchmark ${report.status}. Raw report: ${path.join(run, 'report.json')}`);
  if (report.failures.length) console.error(report.failures.map(f => f.message).join('\n'));
}
