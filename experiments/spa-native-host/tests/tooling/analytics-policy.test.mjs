import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, open, unlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {updatePolicyFile} from '../../tooling/analytics-policy.mjs';

test('operator flag changes publish atomic increasing revisions; malformed selectors preserve last policy', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'spa-policy-'));
  const file = path.join(root, 'policy.json');
  try {
    const first = await updatePolicyFile(file, {enabled: true, names: ['bridge.completed'], properties: {outcome: 'error'}});
    assert.equal(first.revision, 1);
    const second = await updatePolicyFile(file, {properties: {outcome: 'ok'}});
    assert.equal(second.revision, 2); assert.equal(second.enabled, true);
    const bytes = await readFile(file);
    await assert.rejects(updatePolicyFile(file, {properties: {text: 'never capture'}}));
    assert.deepEqual(await readFile(file), bytes);
    assert.equal((await updatePolicyFile(file, {enabled: false})).revision, 3);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('concurrent policy writers cannot publish conflicting selectors under one revision', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'spa-policy-lock-'));
  const file = path.join(root, 'policy.json');
  try {
    await updatePolicyFile(file, {enabled: true});
    const lock = await open(file + '.lock', 'wx');
    try {
      await assert.rejects(updatePolicyFile(file, {enabled: false}), /writer is busy/);
      assert.equal(JSON.parse(await readFile(file, 'utf8')).revision, 1);
    } finally { await lock.close(); await unlink(file + '.lock'); }
    assert.equal((await updatePolicyFile(file, {enabled: false})).revision, 2);
  } finally { await rm(root, {recursive: true, force: true}); }
});
