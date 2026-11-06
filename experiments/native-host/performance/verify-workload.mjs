import assert from 'node:assert/strict';
import {mkdir, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {build} from 'rolldown';
import {bundleConfig, prototypeRoot} from '../scripts/bundle-config.mjs';
import {Host, nodeByID, textOf} from '../testing/host.mjs';
import {REVISION} from './revision.js';
import {ROW_COUNT} from './workload.js';

// Validate the shared workload in real Hermes before spending device samples.
// Input here is synthetic; mobile correctness still requires system input.
const output = path.join(prototypeRoot, 'build/performance');
await mkdir(output, {recursive: true});
const bundle = path.join(output, 'candidate.bundle.js');
const attempt = `${Date.now()}-${process.pid}`;
const report = {attempt, status: 'running', lane: 'real-hermes-headless-synthetic-input',
  revision: REVISION, rowCount: ROW_COUNT, errors: []};
const save = async () => {
  const text = JSON.stringify(report, null, 2) + '\n';
  await writeFile(path.join(output, `workload-check-${attempt}.json`), text);
  const temporary = path.join(output, `workload-check-${attempt}.tmp`);
  await writeFile(temporary, text);
  await rename(temporary, path.join(output, 'workload-check.json'));
};
await save();
let host;
const stages = [];
const errors = [];
try {
  await build(bundleConfig({entry: 'performance/candidate-entry.js', outputFile: bundle}));
  host = new Host({bundle});
  const identity = await host.call('session.describe');
  const tree = () => host.call('ui.snapshot');
  const press = async id => {
    const node = nodeByID(await tree(), id);
    assert.ok(node, `missing ${id}`);
    await host.call('app.event', {nodeId: node.id, event: 'press'});
  };
  let snapshot = await tree();
  assert.equal(textOf(nodeByID(snapshot, 'perf-revision')), `Revision: ${REVISION}`);
  assert.equal(textOf(nodeByID(snapshot, 'perf-mounted')), `Rows: ${ROW_COUNT}`);
  const firstRow = nodeByID(snapshot, 'perf-row-0');
  const lastRow = nodeByID(snapshot, `perf-row-${ROW_COUNT - 1}`);
  assert.ok(firstRow && lastRow);
  stages.push({stage: 'mounted', firstID: firstRow.id, lastID: lastRow.id});
  await press('perf-update');
  snapshot = await tree();
  assert.equal(textOf(nodeByID(snapshot, 'perf-state')), 'Count: 1; order: forward');
  assert.equal(textOf(nodeByID(snapshot, `perf-row-${ROW_COUNT - 1}`)), `Row ${ROW_COUNT - 1}: 1`);
  await press('perf-reorder');
  snapshot = await tree();
  assert.equal(textOf(nodeByID(snapshot, 'perf-state')), 'Count: 1; order: reverse');
  assert.equal(nodeByID(snapshot, 'perf-row-0').id, firstRow.id);
  assert.equal(nodeByID(snapshot, `perf-row-${ROW_COUNT - 1}`).id, lastRow.id);
  const input = nodeByID(snapshot, 'perf-input');
  await host.call('app.event', {nodeId: input.id, event: 'changeText', payload: {text: 'Native ✓'}});
  snapshot = await tree();
  assert.equal(textOf(nodeByID(snapshot, 'perf-input-value')), 'Input: Native ✓');
  await press('perf-toggle');
  snapshot = await tree();
  assert.equal(nodeByID(snapshot, 'perf-row-0'), null);
  assert.equal(textOf(nodeByID(snapshot, 'perf-mounted')), 'Rows: 0');
  await press('perf-toggle');
  snapshot = await tree();
  assert.equal(textOf(nodeByID(snapshot, 'perf-mounted')), `Rows: ${ROW_COUNT}`);
  assert.notEqual(nodeByID(snapshot, 'perf-row-0').id, firstRow.id);
  assert.equal(textOf(nodeByID(snapshot, 'perf-row-0')), 'Row 0: 1');
  await host.call('runtime.pump');
  stages.push({stage: 'remounted', firstID: nodeByID(snapshot, 'perf-row-0').id});
  Object.assign(report, {identity, stages,
    verified: ['revision', '100 rows', 'update', 'keyed reorder identity', 'controlled input', 'unmount', 'remount'],
    notVerified: ['native typography', 'image decoding', 'system input', 'scrolling', 'RN equivalence', 'performance'],
  });
} catch (error) {
  errors.push(error);
} finally {
  try { await host?.stop(); } catch (error) { errors.push(error); }
  report.status = errors.length ? 'failed' : 'passed';
  report.errors = errors.map(error => ({name: error.name, message: error.message}));
  await save();
}
if (errors.length) throw new AggregateError(errors, 'Workload preflight failed');
console.log('Shared performance workload passed real-Hermes preflight.');
