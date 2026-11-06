import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {collectPaired} from '../paired-run.mjs';
import {observeSourceEdit, validateTerminal} from './measurement.mjs';

test('common OS endpoint completes before acknowledgment validation for both lanes', async () => {
  const order = []; let clock = 0;
  for (const backend of ['reference', 'candidate']) {
    const marker = `Revision: ${backend}`;
    const result = await observeSourceEdit({packageName: backend, expectedMarker: marker, now: () => clock,
      write: async () => {order.push(`${backend}:write`); clock += 2;},
      waitForMarker: async () => {order.push(`${backend}:os`); clock += 3; return {exists: true, visible: true, package: backend, text: marker};}});
    assert.equal(result.sourceWriteToMarkerMs, 5);
    // A late acknowledgment must not alter the captured source-to-marker clock.
    order.push(`${backend}:verify`); clock += 1000;
    assert.equal(result.sourceWriteToMarkerMs, 5);
  }
  assert.deepEqual(order, ['reference:write','reference:os','reference:verify','candidate:write','candidate:os','candidate:verify']);
});

test('wrong app, hidden marker and stale text fail even when an observer responds', async () => {
  for (const difference of [{package: 'other'}, {visible: false}, {text: 'Revision: stale'}]) {
    await assert.rejects(observeSourceEdit({packageName: 'expected', expectedMarker: 'Revision: new', write: async () => {},
      waitForMarker: async () => ({exists: true, visible: true, package: 'expected', text: 'Revision: new', ...difference})}));
  }
});

test('applied native acknowledgment must match the exact immutable patch identity', () => {
  const ticket = {sequence: '1', baseRevision: '10', targetRevision: '11', payloadSha256: 'a'.repeat(64)};
  const applied = {generation: 1, sequence: '1', revision: '11'};
  const result = {...ticket, generation: 1, status: 'applied', phase: 'mount-submitted', reloadRequired: false, appliedRevision: '11'};
  const args = {ticket, terminal: {event: 'patch.terminal', result}, applied, generation: 1, sequence: '1', baseRevision: '10'};
  assert.equal(validateTerminal(args), result);
  for (const difference of [{payloadSha256: 'b'.repeat(64)}, {generation: 2}, {reloadRequired: true}, {phase: 'evaluated'}, {sequence: '2'}]) {
    assert.throws(() => validateTerminal({...args, terminal: {event: 'patch.terminal', result: {...result, ...difference}}}));
  }
});

test('visible marker followed by failed acknowledgment cannot yield a passing sample', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'refresh-measure-'));
  try {
    const reportPath = path.join(directory, 'samples.json');
    await assert.rejects(collectPaired({reportPath, count: 1, warmups: 0, context: {fakeObserver: true},
      measure: async ({expectedMarker}) => observeSourceEdit({packageName: 'app', expectedMarker, write: async () => {},
        waitForMarker: async () => ({exists: true, visible: true, package: 'app', text: expectedMarker})}),
      verify: async () => {throw Error('Native acknowledgment mismatch');}}), /acknowledgment mismatch/);
    const report = JSON.parse(await readFile(reportPath));
    assert.equal(report.status, 'failed'); assert.equal(report.samples.length, 1);
    assert.equal(report.summary.complete, false);
  } finally {await rm(directory, {recursive: true, force: true});}
});
