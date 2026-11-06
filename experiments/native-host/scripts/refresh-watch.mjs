import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {randomBytes, createHash} from 'node:crypto';
import {mkdir, readFile, writeFile, open} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createNativeDevEngine, nativeCommonRuntime} from './dev-engine.mjs';
import {buildNativeRefreshBootstrap, nativeRefreshTransform} from './refresh-transform.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
let entry = path.join(root, 'performance/refresh/entry.js');
let applicationDirectory = path.join(root, 'performance/refresh/application');
let transportBinary = path.join(root, 'dev-refresh/target/release/native-host-refresh-transport');
let outputDirectory;
for (let i = 2; i < process.argv.length; i += 2) {
  const value = process.argv[i + 1];
  if (!value) throw new Error(`Missing option value: ${process.argv[i]}`);
  switch (process.argv[i]) {
    case '--entry': entry = path.resolve(value); break;
    case '--application-directory': applicationDirectory = path.resolve(value); break;
    case '--transport': transportBinary = path.resolve(value); break;
    case '--output-directory': outputDirectory = path.resolve(value); break;
    default: throw new Error(`Unknown option: ${process.argv[i]}`);
  }
}
const relativeApplication = path.relative(root, applicationDirectory).split(path.sep).join('/');
if (relativeApplication.startsWith('../') || path.isAbsolute(relativeApplication)) throw new Error('Application directory must be inside the prototype');
const sessionId = randomBytes(16).toString('hex'), token = randomBytes(32).toString('hex');
const revisionPrefix = `${Date.now()}${randomBytes(8).readBigUInt64BE().toString().padStart(20, '0')}`;
const revision = sequence => `${revisionPrefix}${String(sequence).padStart(8, '0')}`;
const directory = outputDirectory || path.join(root, 'build/refresh-publisher', sessionId);
await mkdir(path.dirname(directory), {recursive: true});
await mkdir(directory, {recursive: false});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const redact = value => String(value).replaceAll(token, '[redacted]').slice(0, 8192);
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const receipt = {schemaVersion: 1, sessionId, startedAt: new Date().toISOString(), directory,
  entry, applicationDirectory, status: 'starting', applied: [], compilerErrors: [], errors: []};
let engine, transport, transportClosed = false, transportExit, transportStderr = '', transportInput = '';
let state = 'starting', baseRevision = revision(0), sequence = 1, initialSha, generation;
let queue = [], queuedBytes = 0, preparing, inFlight, work = Promise.resolve(), closing, timeout;
let initialOutputSeen = false, dirtyBeforeConnect = false, initialSources;
const compiledSources = new Map();

function schedule(operation) {
  work = work.then(async () => {if (!closing) await operation();}).catch(error => {if (!closing) return fail(error);});
}
function fail(error) {
  receipt.errors.push({message: redact(error?.stack || error)});
  return stop('failed', 1);
}
async function stop(status = 'stopped', code = 0) {
  if (!closing && status === 'stopped' && (preparing || inFlight || queue.length)) {
    status = inFlight ? 'cancelled-reload-required' : 'cancelled'; code = 2;
    receipt.cancellation = {preparing: preparing || null, inFlight: inFlight || null, queuedPatches: queue.length,
      nativeOutcome: inFlight ? 'unknown; explicit reload required' : 'no patch currently in flight'};
  }
  if (code) process.exitCode = code;
  if (closing) {if (code) receipt.status = 'failed'; return closing;}
  receipt.status = status; state = 'stopping'; clearTimeout(timeout); process.stdin.pause();
  closing = (async () => {
    const cleanup = await Promise.allSettled([
      Promise.resolve().then(() => engine?.close()),
      Promise.resolve().then(async () => {
        if (!transport) return;
        if (!transportClosed) {
          const closed = new Promise(resolve => transport.once('close', resolve));
          if (!transport.stdin.destroyed) {transport.stdin.write('{"method":"quit"}\n'); transport.stdin.end();}
          let forced = false;
          const timer = setTimeout(() => {forced = true; transport.kill('SIGKILL');}, 3000);
          try {await closed;} finally {clearTimeout(timer);}
          if (forced) throw new Error('Transport cleanup exceeded deadline');
        }
        if (!transportExit || transportExit.code !== 0 || transportExit.signal) throw new Error(`Transport teardown failed: ${JSON.stringify(transportExit)}`);
        if (transportStderr.trim()) throw new Error(`Transport stderr: ${transportStderr}`);
      }),
    ]);
    cleanup.forEach((result, index) => {if (result.status === 'rejected') receipt.errors.push({phase: index ? 'transport-cleanup' : 'compiler-cleanup', message: redact(result.reason)});});
    if (receipt.errors.length) {receipt.status = 'failed'; process.exitCode = 1;}
    receipt.finishedAt = new Date().toISOString(); receipt.pendingPatches = queue.length + (preparing ? 1 : 0) + (inFlight ? 1 : 0);
    await writeFile(path.join(directory, 'report.json'), `${JSON.stringify(receipt, null, 2)}\n`, {flag: 'wx'});
    state = 'stopped'; emit({event: 'stopped', status: receipt.status, report: path.join(directory, 'report.json')});
  })();
  return closing;
}
async function reload(reason) {
  emit({event: 'reload-required', reason: redact(reason)});
  receipt.reloadReason = redact(reason);
  await stop('reload-required', 2);
}
async function initialOutput(output) {
  if (output instanceof Error) {
    if (!initialSha) throw output;
    receipt.compilerErrors.push(redact(output)); emit({event: 'compiler.error', message: redact(output)}); return;
  }
  if (initialSha) return reload('Compiler emitted another full bundle; restart the development session');
  const chunks = output.output.filter(item => item.type === 'chunk');
  if (chunks.length !== 1 || !chunks[0].map) throw new Error('Initial native output must be one script and source map');
  const bundle = chunks[0].code, sourceMap = JSON.stringify(chunks[0].map);
  initialSha = digest(bundle);
  const initialDirectory = path.join(directory, 'revisions', baseRevision); await mkdir(initialDirectory, {recursive: true});
  const bundleFile = path.join(initialDirectory, 'app.bundle.js'), sourceMapFile = `${bundleFile}.map`;
  const manifestFile = path.join(initialDirectory, 'manifest.json'), configFile = path.join(directory, 'session.json');
  await writeFile(bundleFile, bundle, {flag: 'wx'}); await writeFile(sourceMapFile, sourceMap, {flag: 'wx'});
  const manifest = {schemaVersion: 1, revision: baseRevision, sha256: initialSha, byteLength: Buffer.byteLength(bundle),
    sourceMap: {file: 'app.bundle.js.map', sha256: digest(sourceMap), byteLength: Buffer.byteLength(sourceMap)},
    createdAt: new Date().toISOString(), mode: 'development', reload: 'full'};
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, {flag: 'wx'});
  await writeFile(configFile, `${JSON.stringify({schemaVersion: 1, port: 0, token, sessionId,
    initialRevision: baseRevision, initialBundleSha256: initialSha}, null, 2)}\n`, {flag: 'wx', mode: 0o600});
  if (closing) return;
  receipt.initial = {bundleFile, sourceMapFile, manifestFile, initialRevision: baseRevision, initialBundleSha256: initialSha};
  receipt.initialSourceHashes = Object.fromEntries(initialSources);
  state = 'ready'; receipt.status = 'ready';
  clearTimeout(timeout);
  await writeFile(path.join(directory, 'running.json'), `${JSON.stringify({...receipt, pid: process.pid}, null, 2)}\n`, {flag: 'wx'});
  if (closing) return;
  emit({event: 'initial.ready', ...receipt.initial, configFile, sessionId});
}
async function nextPatch() {
  if (closing || state !== 'connected' || preparing || inFlight || !queue.length) return;
  if (sequence > 99999999) return reload('Development session sequence limit reached');
  const update = queue.shift(); queuedBytes -= Buffer.byteLength(update.code) + Buffer.byteLength(update.sourcemap || '');
  const targetRevision = revision(sequence);
  preparing = {sequence: String(sequence), baseRevision, targetRevision, compilerFilename: update.filename};
  emit({event: 'patch.preparing', sequence: String(sequence), baseRevision, targetRevision});
  const metadata = {schemaVersion: 1, sequence, changedIds: update.changedIds};
  const payload = `${update.code}\nglobalThis.__nhApplyDevUpdate(${JSON.stringify(metadata)});\n`;
  if (Buffer.byteLength(payload) > 4 * 1024 * 1024 || payload.includes('\0')) return reload('Patch exceeds native payload contract');
  const patchDirectory = path.join(directory, `patch-${String(sequence).padStart(8, '0')}`); await mkdir(patchDirectory);
  if (closing) return;
  // Deterministic test-only pause at the asynchronous file-write boundary.
  // The receipt marks injected pauses; this is not a performance measurement.
  const pause = Number(process.env.NH_REFRESH_TEST_PREPARE_DELAY_MS || 0);
  if (!Number.isInteger(pause) || pause < 0 || pause > 1000) throw new Error('Invalid test preparation delay');
  if (pause) {receipt.testPrepareDelayMs = pause;await new Promise(resolve => setTimeout(resolve, pause));}
  if (closing) return;
  const payloadFile = path.join(patchDirectory, 'patch.js'), sourceMapFile = path.join(patchDirectory, 'patch.js.map');
  const payloadSha256 = digest(payload);
  await writeFile(payloadFile, payload, {flag: 'wx'});
  if (closing) return;
  await writeFile(sourceMapFile, update.sourcemap || '', {flag: 'wx'});
  if (closing) return;
  const ticket = {sequence: String(sequence), baseRevision, targetRevision, payloadSha256, payloadFile,
    compilerFilename: update.filename, compilerSequence: update.seq, sourceMapFile};
  await writeFile(path.join(patchDirectory, 'manifest.json'), `${JSON.stringify(ticket, null, 2)}\n`, {flag: 'wx'});
  if (closing) return;
  preparing = undefined; inFlight = ticket;
  transport.stdin.write(`${JSON.stringify({method: 'patch', sequence: String(sequence), baseRevision, targetRevision, payloadSha256, payloadFile})}\n`);
  timeout = setTimeout(() => void fail(new Error('Transport terminal acknowledgement timed out')), 30000);
  emit({event: 'patch.sent', sequence: String(sequence), baseRevision, targetRevision, payloadSha256, payloadFile});
}
async function compilerUpdate(value) {
  if (value instanceof Error) {
    if (receipt.compilerErrors.length >= 64) return reload('Compiler diagnostic retention limit reached');
    receipt.compilerErrors.push(redact(value)); emit({event: 'compiler.error', message: redact(value)}); return;
  }
  for (const {clientId, update} of value.updates) {
    if (clientId !== sessionId || update.type === 'Noop') continue;
    if (update.type === 'FullReload') return reload(update.reason || 'Compiler requires full reload');
    if (update.type !== 'Patch') throw new Error('Unknown compiler update type');
    const bytes = Buffer.byteLength(update.code) + Buffer.byteLength(update.sourcemap || '');
    if (queue.length + (preparing ? 1 : 0) + (inFlight ? 1 : 0) >= 16 || queuedBytes + bytes > 64 * 1024 * 1024) return reload('Pending patch queue capacity exceeded');
    queue.push(update); queuedBytes += bytes;
  }
  await nextPatch();
}
async function transportMessage(message) {
  if (message.event === 'fatal') throw new Error(`Transport fatal: ${redact(message.message)}`);
  if (message.event === 'ready') {
    if (state !== 'connecting' || !Number.isSafeInteger(message.generation) || message.generation < 1 ||
        message.revision !== baseRevision || message.sequence !== '1') throw new Error('Transport ready identity mismatch');
    clearTimeout(timeout); generation = message.generation;
    await verifyInitialSources();
    if (closing) return;
    await engine.registerClient(sessionId);
    await verifyInitialSources();
    if (closing) return;
    state = 'connected'; receipt.status = 'connected'; receipt.generation = generation;
    emit({event: 'connected', generation, revision: baseRevision, sequence: '1'}); return;
  }
  if (message.event !== 'patch.terminal' || !inFlight) throw new Error('Unexpected transport event');
  clearTimeout(timeout);
  const result = message.result;
  await writeFile(path.join(path.dirname(inFlight.payloadFile), 'terminal.json'), `${JSON.stringify(message, null, 2)}\n`, {flag: 'wx'});
  if (closing) return;
  // Validate the full acknowledged identity before advancing the producer.
  if (result.generation !== generation || result.sequence !== inFlight.sequence ||
      result.baseRevision !== inFlight.baseRevision || result.targetRevision !== inFlight.targetRevision || result.payloadSha256 !== inFlight.payloadSha256) {
    throw new Error('Terminal acknowledgement identity mismatch');
  }
  if (result.status !== 'applied') return reload(`Native update ${result.status}: ${result.phase || ''} ${result.error || result.message || ''}`);
  if (result.appliedRevision !== inFlight.targetRevision || result.reloadRequired !== false || result.phase !== 'mount-submitted') throw new Error('Applied acknowledgement is incomplete');
  await engine.notifyPayloadDelivered(inFlight.compilerFilename);
  if (closing) return;
  receipt.applied.push({...inFlight, terminal: result});
  baseRevision = inFlight.targetRevision; sequence++; inFlight = undefined;
  emit({event: 'patch.applied', generation, revision: baseRevision, sequence: String(sequence - 1)});
  await nextPatch();
}
async function verifyInitialSources() {
  await engine.ensureCurrentBuildFinish();
  if (dirtyBeforeConnect) throw new Error('Application graph changed after initial bundle; explicit rebuild/reload required');
  for (const [filename, expected] of initialSources) {
    if (digest(await readFile(filename)) !== expected) throw new Error(`Source changed after initial bundle: ${filename}; explicit rebuild/reload required`);
  }
  if (dirtyBeforeConnect) throw new Error('Application graph changed during connection; explicit reload required');
}
async function privateConfig(configPath) {
  const handle = await open(configPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 16384 || (info.mode & 0o077) !== 0) throw new Error('Transport config must be a private regular file of at most 16 KiB');
    const buffer = Buffer.alloc(16385);
    const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16384 || bytesRead !== info.size) throw new Error('Transport config changed or exceeds 16 KiB');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally {await handle.close();}
}
async function connect(configPath) {
  if (state !== 'ready') throw new Error('Connect requires initial.ready and no previous connection');
  if (typeof configPath !== 'string' || !path.isAbsolute(configPath)) throw new Error('Connect config must be an absolute path');
  const config = await privateConfig(configPath);
  if (closing) return;
  if (config.schemaVersion !== 1 || config.host !== '127.0.0.1' || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 ||
      config.token !== token || config.sessionId !== sessionId || config.initialRevision !== baseRevision || config.initialBundleSha256 !== initialSha) throw new Error('Transport config does not match this initial session');
  await verifyInitialSources();
  if (closing) return;
  state = 'connecting';
  transport = spawn(transportBinary, ['--config', configPath], {stdio: ['pipe', 'pipe', 'pipe']});
  transport.stdin.on('error', error => {if (!closing) void fail(error);});
  transport.on('error', error => {if (!closing) void fail(error);});
  transport.on('exit', (code, signal) => {transportExit = {code, signal};});
  transport.on('close', () => {transportClosed = true;if (!closing) void fail(new Error(`Transport exited unexpectedly: ${JSON.stringify(transportExit)}`));});
  transport.stderr.on('data', bytes => {transportStderr = (transportStderr + redact(bytes)).slice(-65536);});
  transport.stdout.on('data', bytes => {
    transportInput += bytes.toString('utf8');
    if (transportInput.length > 65536) {void fail(new Error('Transport output exceeds line bound'));return;}
    let newline; while ((newline = transportInput.indexOf('\n')) !== -1) {
      const line = transportInput.slice(0, newline); transportInput = transportInput.slice(newline + 1);
      schedule(async () => {await transportMessage(JSON.parse(line));});
    }
  });
  timeout = setTimeout(() => void fail(new Error('Transport ready timed out')), 10000);
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', bytes => {
  input += bytes;
  if (input.length > 16384) {void fail(new Error('Publisher control input exceeds line bound'));return;}
  let newline;while ((newline = input.indexOf('\n')) !== -1) {
    const line = input.slice(0, newline);input = input.slice(newline + 1);
    schedule(async () => {const command = JSON.parse(line);if (command.method === 'connect') await connect(command.config);else if (command.method === 'quit') await stop();else throw new Error('Unknown publisher command');});
  }
});
process.stdin.on('end', () => {void stop();});
process.once('SIGINT', () => {void stop();});process.once('SIGTERM', () => {void stop();});
process.stdout.on('error', error => {void fail(error);});
try {
  timeout = setTimeout(() => void fail(new Error('Initial compiler output timed out')), 30000);
  const runtime = await buildNativeRefreshBootstrap({clientId: sessionId, applicationPrefix: `${relativeApplication}/`});
  receipt.bootstrapSha256 = digest(runtime);
  const common = await nativeCommonRuntime();receipt.commonRuntime = {originalSha256: common.originalSha256, adaptedSha256: common.adaptedSha256};
  if (!closing) engine = await createNativeDevEngine({root, entry, runtime,
    transform: {define: {'process.env.NODE_ENV': '"development"', __NH_TEST_HOOKS__: 'false'}},
    plugins: [{name: 'native-refresh-initial-source-integrity', transform(source, id) {if (path.isAbsolute(id)) compiledSources.set(id, digest(source));return null;}}, nativeRefreshTransform({root, applicationDirectory})],
    onOutput: output => {
      if (!(output instanceof Error) && !initialOutputSeen) {initialOutputSeen = true; initialSources = new Map(compiledSources);}
      schedule(() => initialOutput(output));
    }, onHmrUpdates: value => {
      if (initialOutputSeen && state !== 'connected' && !(value instanceof Error) && value.changedFiles.length) dirtyBeforeConnect = true;
      schedule(async () => {if (dirtyBeforeConnect) return reload('Application graph changed before connection; stage a fresh initial bundle');await compilerUpdate(value);});
    },
    onAdditionalAssets: () => schedule(() => reload('Native asset updates are not implemented'))});
  if (closing) await engine?.close(); else await engine.run();
} catch (error) {await fail(error);}
