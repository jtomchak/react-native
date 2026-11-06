import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, access, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {runProcess} from './process.mjs';

test('captures complete stdout before resolving', async () => {
  const output = await runProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(100000));"]);
  assert.equal(output.length, 100000);
});

test('timeout stops an actual descendant before it can perform delayed work', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'native-host-process-test-'));
  const ready = path.join(directory, 'ready'), late = path.join(directory, 'late');
  const grandchild = `require('fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(late)},'unexpected'),2000)`;
  const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'inherit'});setInterval(()=>{},10000)`;
  try {
    await assert.rejects(runProcess(process.execPath, ['-e', parent], {timeout: 1000}), /timed out/);
    const pid = Number(await readFile(ready, 'utf8'));
    assert.ok(pid > 0, 'descendant really started');
    await new Promise(resolve => setTimeout(resolve, 1200));
    await assert.rejects(access(late), {code: 'ENOENT'});
    assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'});
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('output overflow fails instead of parsing truncated command output', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(100000));setInterval(()=>{},10000)"], {maxOutput: 100}), /exceeded/);
});
