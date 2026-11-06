import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {collectPaired, summarize} from './paired-run.mjs';

async function temporary(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'native-host-measurement-test-'));
  try { await run(path.join(directory, 'report.json')); }
  finally { await rm(directory, {recursive: true, force: true}); }
}

test('measurement harness alternates pairs, excludes warmups and preserves unique marker observations', () => temporary(async reportPath => {
  const order = [], markers = new Set();
  const report = await collectPaired({reportPath, count: 2, warmups: 1,
    context: {lane: 'unit-test-fake-observer-not-performance-evidence'},
    measure: async ({backend, expectedMarker}) => {
      order.push(backend); assert.ok(!markers.has(expectedMarker)); markers.add(expectedMarker);
      return {observedMarker: expectedMarker, mechanism: 'os-accessibility'};
    }});
  assert.deepEqual(order, ['reference', 'candidate', 'candidate', 'reference', 'reference', 'candidate']);
  assert.equal(report.summary.complete, true);
  assert.equal(report.summary.acceptanceEligibleSampleCount, false);
  assert.equal(report.summary.lanes.reference.count, 2);
}));

test('stale marker fails and remains in the report without retry', () => temporary(async reportPath => {
  let calls = 0;
  await assert.rejects(collectPaired({reportPath, count: 30, warmups: 0, context: {lane: 'unit-test'},
    measure: async () => { calls++; return {observedMarker: 'Revision: old', mechanism: 'os-accessibility'}; }}), /stale/);
  const report = JSON.parse(await readFile(reportPath));
  assert.equal(calls, 1); assert.equal(report.status, 'failed');
  assert.equal(report.samples[0].status, 'failed');
  assert.equal(report.summary.complete, false);
}));

test('internal render observation cannot pass the external-observer requirement', () => temporary(async reportPath => {
  await assert.rejects(collectPaired({reportPath, count: 1, warmups: 0, context: {lane: 'unit-test'},
    measure: async ({expectedMarker}) => ({observedMarker: expectedMarker, mechanism: 'internal-commit'})}), /OS accessibility/);
}));

test('warmup failures and incomplete pairs cannot produce eligible summaries', () => {
  const sample = (backend, durationMs, warmup = false) => ({backend, durationMs, warmup, status: 'passed'});
  const samples = [sample('reference', 100), sample('candidate', 80), sample('reference', 200), sample('candidate', 120)];
  const result = summarize(samples, 2);
  assert.equal(result.lanes.reference.p95Ms, 200);
  assert.equal(result.lanes.candidate.medianMs, 80);
  assert.equal(summarize(samples.slice(0, 3), 2).complete, false);
  assert.equal(summarize([...samples, {...sample('candidate', 1, true), status: 'failed'}], 2).complete, false);
});

test('failed post-observation state verification invalidates the sample', () => temporary(async reportPath => {
  await assert.rejects(collectPaired({reportPath, count: 1, warmups: 0, context: {lane: 'unit-test'},
    prepare: async () => ({countBefore: 1}),
    measure: async ({expectedMarker}) => ({observedMarker: expectedMarker, mechanism: 'os-accessibility'}),
    verify: async ({preparation}) => { assert.equal(preparation.countBefore, 1); throw new Error('State unexpectedly reset'); },
  }), /unexpectedly reset/);
  const report = JSON.parse(await readFile(reportPath));
  assert.equal(report.status, 'failed');
  assert.equal(report.samples[0].status, 'failed');
  assert.equal(report.summary.acceptanceEligibleSampleCount, false);
}));
