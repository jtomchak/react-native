import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {runOwnedProcess, ProcessFailure} from '../../tooling/process.mjs';

const options = {stdio: 'ignore', handleSignals: false, graceMs: 100, termMs: 100, killMs: 1000};
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function waitFile(file) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try { return await readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(10);
  }
  throw new Error('Fixture did not start');
}
function exists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

test('owned command preserves clean exit and nonzero failure status', async () => {
  assert.deepEqual(await runOwnedProcess(process.execPath, ['-e', 'process.exit(0)'], options), {code: 0, signal: null});
  await assert.rejects(runOwnedProcess(process.execPath, ['-e', 'process.exit(17)'], options), error => error instanceof ProcessFailure && error.exitCode === 17);
});

test('owned command preserves external termination signal', async () => {
  await assert.rejects(runOwnedProcess(process.execPath, ['-e', "process.kill(process.pid, 'SIGTERM')"], options), error => error.signal === 'SIGTERM' && error.exitCode === 143);
});

test('cancellation escalates for an unresponsive command and cleans its descendant', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'spa-process-'));
  const ready = path.join(directory, 'ready');
  const controller = new AbortController();
  const source = `
    const {spawn}=require('node:child_process');
    const fs=require('node:fs');
    process.on('SIGINT',()=>{}); process.on('SIGTERM',()=>{});
    const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
    fs.writeFileSync(process.argv[1],JSON.stringify({parent:process.pid,child:child.pid}));
    setInterval(()=>{},1000);
  `;
  const running = runOwnedProcess(process.execPath, ['-e', source, ready], {...options, signal: controller.signal});
  const outcome = running.then(() => null, error => error);
  try {
    const pids = JSON.parse(await waitFile(ready));
    controller.abort();
    const error = await outcome;
    assert.equal(error.exitCode, 143);
    const deadline = Date.now() + 1500;
    while ((exists(pids.parent) || exists(pids.child)) && Date.now() < deadline) await delay(20);
    assert.equal(exists(pids.parent), false);
    assert.equal(exists(pids.child), false);
  } finally { controller.abort(); await outcome; await rm(directory, {recursive: true, force: true}); }
});

test('even a clean wrapper exit detects and cleans a surviving owned descendant', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'spa-orphan-'));
  const ready = path.join(directory, 'ready');
  try {
    const source = `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[1],String(child.pid));child.unref();`;
    await assert.rejects(runOwnedProcess(process.execPath, ['-e', source, ready], options), /left descendants running/);
    const pid = Number(await waitFile(ready));
    assert.equal(exists(pid), false);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('pre-cancelled commands never spawn and failed launches reject', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runOwnedProcess(process.execPath, ['-e', 'process.exit(0)'], {...options, signal: controller.signal}), /before launch/);
  await assert.rejects(runOwnedProcess('/definitely/not/a/command', [], options), error => error.code === 'ENOENT');
});

test('a real CLI-owner SIGINT reaches its command and preserves interruption status', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'spa-cli-signal-'));
  const ready = path.join(directory, 'ready');
  const stopped = path.join(directory, 'stopped');
  const helper = new URL('../../tooling/process.mjs', import.meta.url).href;
  const command = `const fs=require('node:fs');process.on('SIGINT',()=>{fs.writeFileSync(process.argv[2],'closed');process.exit(0)});fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)`;
  const owner = spawn(process.execPath, ['--input-type=module', '-e', `import {runOwnedProcess} from ${JSON.stringify(helper)};try{await runOwnedProcess(process.execPath,['-e',${JSON.stringify(command)},${JSON.stringify(ready)},${JSON.stringify(stopped)}],{stdio:'ignore',graceMs:200,termMs:100,killMs:1000})}catch(error){process.exitCode=error.exitCode||1}`], {stdio: 'ignore'});
  const closed = new Promise((resolve, reject) => { owner.once('error', reject); owner.once('close', (code, signal) => resolve({code, signal})); });
  try {
    const pid = Number(await waitFile(ready));
    owner.kill('SIGINT');
    assert.deepEqual(await closed, {code: 130, signal: null});
    assert.equal(await readFile(stopped, 'utf8'), 'closed');
    assert.equal(exists(pid), false);
  } finally { if (owner.exitCode === null) owner.kill('SIGKILL'); await closed; await rm(directory, {recursive: true, force: true}); }
});

test('consecutive EPERM probes require a later ESRCH before absence is accepted', async () => {
  const kill = process.kill;
  let permissionProbes = 0;
  process.kill = function(pid, signal) {
    if (pid < 0 && signal === 0 && permissionProbes++ < 3) throw Object.assign(new Error('Simulated disappearing-group EPERM'), {code: 'EPERM'});
    return kill.call(process, pid, signal);
  };
  try {
    assert.deepEqual(await runOwnedProcess(process.execPath, ['-e', 'process.exit(0)'], options), {code: 0, signal: null});
    assert.ok(permissionProbes >= 4);
  } finally { process.kill = kill; }
});

test('persistent EPERM cannot be reported as successful group cleanup', async () => {
  const kill = process.kill;
  process.kill = function(pid, signal) {
    if (pid < 0 && signal === 0) throw Object.assign(new Error('Simulated persistent EPERM'), {code: 'EPERM'});
    return kill.call(process, pid, signal);
  };
  try {
    await assert.rejects(runOwnedProcess(process.execPath, ['-e', 'process.exit(0)'], {...options, killMs: 60}), error => error.code === 'EPERM');
  } finally { process.kill = kill; }
});
