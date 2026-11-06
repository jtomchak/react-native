import {watch, VERSION} from 'rolldown';
import {createHash, randomBytes} from 'node:crypto';
import {mkdir, rm} from 'node:fs/promises';
import {readFileSync, mkdirSync, writeFileSync, renameSync, rmSync} from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {bundleConfig, prototypeRoot} from './bundle-config.mjs';

// stdout is bounded control traffic. Compiler diagnostics use stderr.
const emit = (...fields) => process.stdout.write(`${fields.join('\t')}\n`);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let root = prototypeRoot;
let entry = 'js/entry.jsx';
let buildDelay = 35;
for (let i = 2; i < process.argv.length; i += 2) {
  const value = process.argv[i + 1];
  if (value === undefined) throw new Error(`Missing value: ${process.argv[i]}`);
  switch (process.argv[i]) {
    case '--root': root = path.resolve(value); break;
    case '--entry': entry = value; break;
    case '--build-delay': buildDelay = Number(value); break;
    default: throw new Error(`Unknown option: ${process.argv[i]}`);
  }
}
if (!Number.isInteger(buildDelay) || buildDelay < 0 || buildDelay > 10000) {
  throw new Error('Build delay must be an integer from 0 to 10000 milliseconds');
}

// Keep it a string: the session prefix is intentionally larger than Number's
// safe integer range. mkdir/rename still reject a collision rather than replace.
const session = `${Date.now()}${randomBytes(8).readBigUInt64BE().toString().padStart(20, '0')}`;
const staging = path.join(root, 'build', '.watch-output', session);
const revisions = path.join(root, 'build', 'revisions');
const bundleFile = path.join(staging, 'app.bundle.js');
await mkdir(staging, {recursive: true});
await mkdir(revisions, {recursive: true});
let sequence = 0;
let changeSequence = 0;
let buildSequence = 0;
let buildChange = 0;
let snapshot;
let stopping = false;
let watcher;
let input;

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  input?.close();
  process.stdin.pause();
  try { await watcher?.close(); }
  catch (error) { console.error(error); process.exitCode = 1; }
  await rm(staging, {recursive: true, force: true});
  emit('STOPPED');
}

watcher = watch({
  ...bundleConfig({root, entry, outputFile: bundleFile, plugins: [{
    name: 'native-host-immutable-artifact',
    writeBundle() {
      // Snapshot both files synchronously inside the bundler's write hook.
      // Subsequent rebuilds cannot replace either half of this captured pair.
      snapshot = {
        bundle: readFileSync(bundleFile),
        sourceMap: readFileSync(`${bundleFile}.map`),
        change: buildChange,
      };
    },
  }]}),
  watch: {buildDelay},
});

watcher.on('change', () => emit('CHANGE', ++changeSequence));
watcher.on('event', async event => {
  try {
    if (event.code === 'BUNDLE_START') {
      snapshot = undefined;
      buildChange = changeSequence;
      emit('BUILD_START', ++buildSequence);
    } else if (event.code === 'ERROR') {
      snapshot = undefined;
      console.error(String(event.error).slice(0, 8192));
      emit('ERROR', buildSequence, buildChange);
      await event.result?.close();
    } else if (event.code === 'BUNDLE_END') {
      try {
        if (stopping) return;
        if (!snapshot) throw new Error('Successful build did not produce a bundle/map pair');
        const {bundle, sourceMap, change} = snapshot;
        snapshot = undefined;
        const revision = `${session}${String(++sequence).padStart(8, '0')}`;
        const temporary = path.join(revisions, `.pending-${revision}`);
        const final = path.join(revisions, revision);
        const manifest = {
          schemaVersion: 1, revision, sha256: hash(bundle), byteLength: bundle.length,
          sourceMap: {file: 'app.bundle.js.map', sha256: hash(sourceMap), byteLength: sourceMap.length},
          createdAt: new Date().toISOString(), mode: 'development', reload: 'full',
          buildDurationMs: event.duration,
        };
        mkdirSync(temporary);
        try {
          writeFileSync(path.join(temporary, 'app.bundle.js'), bundle, {flag: 'wx'});
          writeFileSync(path.join(temporary, 'app.bundle.js.map'), sourceMap, {flag: 'wx'});
          writeFileSync(path.join(temporary, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {flag: 'wx'});
          renameSync(temporary, final);
        } catch (error) {
          rmSync(temporary, {recursive: true, force: true});
          throw error;
        }
        emit('BUNDLE', revision, manifest.sha256, bundle.length, event.duration, change);
      } finally {
        await event.result.close();
      }
    }
  } catch (error) {
    console.error(error);
    // Close outside this event callback to avoid awaiting our own completion.
    setImmediate(() => void stop(1));
  }
});

input = readline.createInterface({input: process.stdin});
input.on('line', line => {
  if (line === 'quit') void stop();
  else { console.error('Unknown watcher control command'); void stop(1); }
});
input.on('close', () => { if (!stopping) void stop(); });
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
process.stdout.on('error', () => void stop(1));
emit('READY', process.pid, VERSION);
