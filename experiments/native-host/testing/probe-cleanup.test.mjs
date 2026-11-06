import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {describeError, restoreThenStop} from '../scripts/probe-cleanup.mjs';

test('a disappeared source does not leak the running probe child', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nh-probe-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  const exited = once(child, 'exit');
  try {
    await assert.rejects(restoreThenStop(
      () => readFile(path.join(directory, 'missing.jsx')),
      async () => { child.kill('SIGTERM'); await exited; },
    ), error => error instanceof AggregateError && error.errors[0].code === 'ENOENT');
    assert.equal(child.signalCode, 'SIGTERM');
  } finally { child.kill(); await rm(directory, {recursive: true, force: true}); }
});

test('restoration and shutdown failures both survive', async () => {
  const restore = new Error('restore failed');
  const stop = new Error('shutdown failed');
  await assert.rejects(restoreThenStop(async () => { throw restore; }, async () => { throw stop; }), error => {
    assert.deepEqual(error.errors, [restore, stop]);
    assert.deepEqual(describeError(error).errors.map(item => item.message), ['restore failed', 'shutdown failed']);
    return true;
  });
});
