// Controlled source-write measurement. This is not edit-to-visible latency.
import {spawn} from 'node:child_process';
import {copyFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {describeError, restoreThenStop} from './probe-cleanup.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.join(root, 'build/app-watch-evidence.json');
const attempt = `${Date.now()}-${process.pid}`;
await mkdir(path.join(root, 'build'), {recursive: true});
try { await copyFile(evidence, path.join(root, `build/app-watch-before-${attempt}.json`)); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await writeFile(evidence, JSON.stringify({schemaVersion: 1, status: 'running', attempt}) + '\n');
async function saveReport(report) {
  const text = JSON.stringify(report, null, 2) + '\n';
  await writeFile(path.join(root, `build/app-watch-attempt-${attempt}.json`), text);
  await writeFile(evidence, text);
}
const source = path.join(root, 'js/app.jsx');
const before = 'Native host prototype';
const after = 'Native host reload verified';
let original;
try {
  original = await readFile(source, 'utf8');
  if (original.split(before).length !== 2) throw new Error('Expected one unchanged demo heading');
} catch (error) {
  await saveReport({schemaVersion: 1, attempt, status: 'failed', errors: [describeError(error)]});
  throw error;
}
const modified = original.replace(before, after);
const child = spawn(path.join(root, 'dev/target/debug/native-host-dev'), [], {cwd: root, stdio: ['pipe', 'pipe', 'inherit']});
const exited = once(child, 'exit').catch(error => [null, null, error]);
const events = [];
let waiting;
let failure;
child.stdin.on('error', error => { failure ??= error; waiting?.(); });
createInterface({input: child.stdout}).on('line', line => {
  try {
    const event = JSON.parse(line);
    events.push({...event, observedAtMs: performance.now()});
    waiting?.();
  } catch (error) { failure = error; waiting?.(); }
});
child.on('error', error => { failure = error; waiting?.(); });
child.on('exit', code => { failure ??= new Error(`Supervisor exited: ${code}`); waiting?.(); });
async function nextRevision(start) {
  const deadline = performance.now() + 30000;
  while (performance.now() < deadline) {
    if (failure) throw failure;
    const event = events.slice(start).find(item => item.event === 'revision.ready');
    if (event) return event;
    await new Promise(resolve => {
      const timer = setTimeout(() => { waiting = undefined; resolve(); }, 100);
      waiting = () => { clearTimeout(timer); waiting = undefined; resolve(); };
    });
  }
  throw new Error('Timed out waiting for a published revision');
}
let changed = false;
let report;
const errors = [];
async function verifyContent(revision, heading, expectedSource) {
  const bundle = await readFile(path.join(revision.directory, 'app.bundle.js'), 'utf8');
  const map = JSON.parse(await readFile(path.join(revision.directory, 'app.bundle.js.map'), 'utf8'));
  if (!bundle.includes(heading) || !map.sourcesContent.some(content => content === expectedSource)) throw new Error('Published bundle/map do not contain the expected source');
}
try {
  const baseline = await nextRevision(0);
  await verifyContent(baseline, before, original);
  const index = events.length;
  const writeStarted = performance.now();
  await writeFile(source, modified);
  changed = true;
  const updated = await nextRevision(index);
  await verifyContent(updated, after, modified);
  // Never overwrite an unrelated concurrent user edit while restoring the probe.
  if (await readFile(source, 'utf8') !== modified) throw new Error('Demo source changed concurrently; manual restoration needed');
  const restoreIndex = events.length;
  await writeFile(source, original);
  changed = false;
  const restored = await nextRevision(restoreIndex);
  await verifyContent(restored, before, original);
  report = {schemaVersion: 1, input: 'controlled file write to js/app.jsx',
    measurement: 'source-write-start to immutable revision observed by parent; excludes device deployment and visible frame',
    sourceWriteToArtifactMs: updated.observedAtMs - writeStarted,
    headings: {baseline: before, updated: after}, baseline, updated, restored,
    nativeBuildInvoked: false, intendedReloadMode: 'full', deviceReloadExecuted: false, statePreservingHMR: false};
} catch (error) { errors.push(error); }
finally {
  try {
    await restoreThenStop(async () => {
      if (changed && await readFile(source, 'utf8') === modified) await writeFile(source, original);
    }, async () => {
      if (!child.stdin.destroyed) child.stdin.end('quit\n');
      const timer = setTimeout(() => child.kill('SIGTERM'), 5000);
      const hardStop = setTimeout(() => child.kill('SIGKILL'), 10000);
      try {
        const [code, signal, spawnError] = await exited;
        if (spawnError) throw spawnError;
        if (code !== 0) throw new Error(`Supervisor shutdown failed: ${code ?? signal}`);
      } finally { clearTimeout(timer); clearTimeout(hardStop); }
    });
  } catch (error) { errors.push(error); }
}
report = {...report, schemaVersion: 1, attempt, status: errors.length ? 'failed' : 'passed', errors: errors.map(describeError)};
await saveReport(report);
if (errors.length) throw new AggregateError(errors, 'App watcher probe failed');
console.log(JSON.stringify(report, null, 2));
