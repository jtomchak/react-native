import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, writeFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const root = fileURLToPath(new URL('../../', import.meta.url));
const binary = path.join(root, 'dev/target/debug/native-host-dev');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'native-host-watch-'));
  await mkdir(path.join(directory, 'js'));
  await writeFile(path.join(directory, 'js/entry.jsx'), "import {message} from './message.js'; globalThis.fixtureMessage = message;\n");
  await writeFile(path.join(directory, 'js/message.js'), 'export const message = "initial";\n');
  t.after(() => rm(directory, {recursive: true, force: true}));
  return directory;
}

function supervisor(t, directory, args = []) {
  const child = spawn(binary, ['--root', directory, ...args], {stdio: ['pipe', 'pipe', 'pipe']});
  let buffer = '', diagnostics = '';
  const events = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { diagnostics += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      events.push(JSON.parse(buffer.slice(0, newline)));
      buffer = buffer.slice(newline + 1);
    }
  });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));
  child.stdin.on('error', () => {});
  async function wait(event, after = 0, predicate = () => true) {
    const deadline = performance.now() + 12000;
    while (performance.now() < deadline) {
      const found = events.slice(after).find(value => value.event === event && predicate(value));
      if (found) return found;
      if (child.exitCode !== null || child.signalCode !== null) break;
      await delay(10);
    }
    throw new Error(`Missing ${event}: ${JSON.stringify(events)}\n${diagnostics}`);
  }
  async function stop(signal = false) {
    if (child.exitCode === null && child.signalCode === null) {
      if (signal) child.kill('SIGTERM'); else child.stdin.end('quit\n');
    }
    const result = await Promise.race([exited, delay(5000).then(() => { throw new Error('Supervisor leaked on shutdown'); })]);
    const watcher = events.find(value => value.event === 'supervisor.started');
    if (watcher) assert.equal(alive(watcher.watcherPid), false, 'watcher exited');
    return result;
  }
  t.after(async () => { await stop(); });
  return {child, events, wait, stop, exited};
}

async function artifact(event, expected) {
  const files = await readdir(event.directory);
  assert.deepEqual(files.sort(), ['app.bundle.js', 'app.bundle.js.map', 'manifest.json']);
  const bundle = await readFile(path.join(event.directory, 'app.bundle.js'));
  const map = await readFile(path.join(event.directory, 'app.bundle.js.map'));
  const manifest = JSON.parse(await readFile(path.join(event.directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.revision, event.revision);
  assert.match(manifest.revision, /^\d+$/);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.reload, 'full');
  assert.equal(manifest.sha256, hash(bundle));
  assert.equal(manifest.sha256, event.sha256);
  assert.equal(manifest.byteLength, bundle.length);
  assert.equal(manifest.sourceMap.sha256, hash(map));
  assert.equal(manifest.sourceMap.byteLength, map.length);
  if (expected !== undefined) {
    assert.ok(bundle.toString().includes(expected));
    assert.ok(JSON.parse(map).sourcesContent.some(source => source.includes(expected)), 'map corresponds to bundle revision');
  }
  return {bundle, map, manifest};
}

test('real persistent watcher rebuilds imports, keeps last-good on error, recovers and restarts uniquely', {timeout: 30000}, async t => {
  const directory = await fixture(t);
  const session = supervisor(t, directory);
  const first = await session.wait('revision.ready');
  const original = await artifact(first, 'initial');
  assert.equal(first.watcherEventToBundleMs, null);
  const mark = session.events.length;
  const started = performance.now();
  await writeFile(path.join(directory, 'js/message.js'), 'export const message = "import-edited";\n');
  const second = await session.wait('revision.ready', mark);
  await artifact(second, 'import-edited');
  assert.ok(second.watcherEventToBundleMs >= 0);
  t.diagnostic(`import edit wall-to-bundle ${Math.round(performance.now() - started)}ms; watcher-observed ${second.watcherEventToBundleMs}ms; Rolldown ${second.bundleMs}ms`);
  const errorMark = session.events.length;
  await writeFile(path.join(directory, 'js/message.js'), 'export const message = ;\n');
  await session.wait('bundle.failed', errorMark);
  assert.equal(session.events.slice(errorMark).filter(e => e.event === 'revision.ready').length, 0);
  assert.deepEqual((await artifact(first, 'initial')).bundle, original.bundle);
  await artifact(second, 'import-edited');
  const recoveryMark = session.events.length;
  await writeFile(path.join(directory, 'js/message.js'), 'export const message = "recovered";\n');
  await artifact(await session.wait('revision.ready', recoveryMark), 'recovered');
  assert.equal((await session.stop()).code, 0);
  const restarted = supervisor(t, directory);
  const fresh = await restarted.wait('revision.ready');
  assert.ok(!session.events.some(e => e.revision === fresh.revision));
  await artifact(fresh, 'recovered');
  assert.equal((await restarted.stop(true)).code, 0);
});

test('burst edits produce consistent immutable pairs and serialize/coalesce explicit deployments', {timeout: 30000}, async t => {
  const directory = await fixture(t);
  const deployScript = path.join(directory, 'deploy.mjs');
  await writeFile(deployScript, `import {existsSync, appendFileSync} from 'node:fs';
const directory = process.argv.at(-1); const root = directory.split('/build/revisions/')[0];
appendFileSync(root + '/deployments', process.env.NH_DEV_REVISION + '\\n');
await new Promise(resolve => { const timer = setInterval(() => { if (existsSync(root + '/release-deploy')) { clearInterval(timer); resolve(); } }, 10); });
`);
  const session = supervisor(t, directory, ['--deploy-command', process.execPath, '--deploy-arg', deployScript]);
  const initial = await session.wait('revision.ready');
  const active = await session.wait('deploy.started');
  const revisions = [initial];
  for (let i = 1; i <= 4; i++) {
    const mark = session.events.length;
    await writeFile(path.join(directory, 'js/message.js'), `export const message = "burst-${i}";\n`);
    const revision = await session.wait('revision.ready', mark);
    revisions.push(revision);
    await artifact(revision, `burst-${i}`);
  }
  assert.ok(session.events.filter(e => e.event === 'deploy.coalesced').length >= 3);
  assert.equal(session.events.filter(e => e.event === 'deploy.started').length, 1);
  await writeFile(path.join(directory, 'release-deploy'), 'go');
  await session.wait('deploy.completed', 0, e => e.revision === revisions.at(-1).revision);
  assert.deepEqual((await readFile(path.join(directory, 'deployments'), 'utf8')).trim().split('\n'), [initial.revision, revisions.at(-1).revision]);
  for (let i = 0; i < revisions.length; i++) await artifact(revisions[i], i === 0 ? 'initial' : `burst-${i}`);
  assert.equal((await session.stop()).code, 0);
  assert.equal(alive(active.pid), false);
});

test('shutdown terminates active deployment and watcher', {timeout: 20000}, async t => {
  const directory = await fixture(t);
  const script = path.join(directory, 'wait.mjs');
  const childPidPath = path.join(directory, 'descendant.pid');
  await writeFile(script, `import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], {stdio: 'ignore'});
writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));
setInterval(() => {}, 1000);
`);
  const session = supervisor(t, directory, ['--deploy-command', process.execPath, '--deploy-arg', script]);
  const deployment = await session.wait('deploy.started');
  let descendant;
  for (let attempt = 0; attempt < 100 && !descendant; attempt++) {
    try { descendant = Number(await readFile(childPidPath, 'utf8')); } catch { await delay(10); }
  }
  assert.ok(descendant);
  assert.equal(alive(descendant), true);
  assert.equal(alive(deployment.pid), true);
  assert.equal((await session.stop(true)).code, 0);
  assert.equal(alive(deployment.pid), false);
  for (let attempt = 0; attempt < 100 && alive(descendant); attempt++) await delay(10);
  assert.equal(alive(descendant), false, 'deployment descendant is terminated even when its parent exits first');
});

test('rapid imported-file edits converge and keep every published bundle/map pair consistent', {timeout: 20000}, async t => {
  const directory = await fixture(t);
  const session = supervisor(t, directory, ['--build-delay', '100']);
  await session.wait('revision.ready');
  const mark = session.events.length;
  for (let i = 0; i < 20; i++) {
    await writeFile(path.join(directory, 'js/message.js'), `export const message = "rapid-${i}";\n`);
    await delay(8);
  }
  const deadline = performance.now() + 10000;
  let found = false;
  while (performance.now() < deadline) {
    for (const revision of session.events.slice(mark).filter(e => e.event === 'revision.ready')) {
      const {bundle, map} = await artifact(revision);
      const source = JSON.parse(map).sourcesContent.find(value => /rapid-\d+/.test(value));
      assert.ok(source, 'source map retains the imported source');
      const label = source.match(/rapid-\d+/)[0];
      assert.ok(bundle.toString().includes(label), 'source map and executable describe the same edit');
      if (label === 'rapid-19') found = true;
    }
    if (found) break;
    await delay(20);
  }
  assert.equal(found, true, 'latest edit eventually publishes');
  assert.equal((await session.stop()).code, 0);
});

test('oversized watcher protocol fails boundedly and reaps child', {timeout: 15000}, async t => {
  const directory = await fixture(t);
  const script = path.join(directory, 'bad-watch.mjs');
  await writeFile(script, 'process.stdout.write("x".repeat(5000)); setInterval(() => {}, 1000);\n');
  const session = supervisor(t, directory, ['--watch-script', script]);
  await session.wait('supervisor.stopped');
  assert.equal((await session.stop()).code, 1);
});
