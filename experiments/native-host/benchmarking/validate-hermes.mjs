import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import assert from 'node:assert/strict';

function find(tree, testID) {
  for (const node of tree.children || []) {
    if (node.props.testID === testID) return node;
    const child = find(node, testID);
    if (child) return child;
  }
}
function text(node) { return node.type === '#text' ? node.props.text : node.children.map(text).join(''); }

// Every artifact runs on the same binary, outside the compilation timing window.
export async function validateHermes(binary, bundle, heading) {
  const child = spawn(binary, ['--bundle', bundle], {stdio: ['pipe', 'pipe', 'pipe']});
  let stderr = '';
  let sequence = 0;
  const pending = new Map();
  child.stderr.on('data', data => { stderr += data; });
  // `close` also fires after spawn errors; `exit` is not guaranteed there.
  const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({code, signal})));
  const fail = error => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); };
  child.on('error', fail);
  child.on('exit', (code, signal) => fail(new Error(`Hermes exited ${code ?? signal}: ${stderr}`)));
  createInterface({input: child.stdout}).on('line', line => {
    try {
      const message = JSON.parse(line);
      const request = pending.get(message.id);
      if (!request) throw new Error(`Unexpected Hermes response: ${line}`);
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.error || message.result?.errors?.length) request.reject(new Error(line));
      else request.resolve(message.result);
    } catch (error) { fail(error); }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Hermes timeout ${method}: ${stderr}`)); }, 10000);
    pending.set(id, {resolve, reject, timer});
    child.stdin.write(`${JSON.stringify({id, method, params})}\n`);
  });
  let output;
  try {
    const identity = await call('session.describe');
    const initial = await call('ui.snapshot');
    assert.equal(text(find(initial, 'heading')), heading);
    assert.equal(text(find(initial, 'count-label')), 'Count: 0');
    await call('app.event', {nodeId: find(initial, 'increment').id, event: 'press'});
    await call('app.event', {nodeId: find(initial, 'name-input').id, event: 'changeText', payload: 'Tooling ✓'});
    const updated = await call('ui.snapshot');
    assert.equal(text(find(updated, 'count-label')), 'Count: 1');
    assert.equal(find(updated, 'name-input').props.value, 'Tooling ✓');
    await call('scenario.load', {name: 'atomic-layout'});
    const atomic = await call('scenario.result');
    assert.deepEqual(atomic.effects, [0, 1]);
    assert.deepEqual(atomic.geometry.map(rect => rect.width), [60, 120]);
    const atomicTree = await call('ui.snapshot');
    await call('scenario.load', {name: 'keyed'});
    const keyedBefore = await call('scenario.result');
    await call('app.event', {nodeId: keyedBefore.ids.a, event: 'press'});
    await call('scenario.action');
    await call('runtime.pump');
    const keyedAfter = await call('scenario.result');
    const keyedTree = await call('ui.snapshot');
    assert.deepEqual(keyedBefore.ids, keyedAfter.ids);
    assert.deepEqual(keyedTree.children[0].children.map(node => node.props.testID), ['b', 'a']);
    assert.equal(text(find(keyedTree, 'a')), 'a!');
    const status = await call('runtime.status');
    assert.deepEqual(status.renderer.errors, []);
    await call('runtime.pump');
    output = {identity, observations: {initial, updated, atomic, atomicTree, keyedBefore, keyedAfter, keyedTree}};
    // Only the deliberately edited visible heading is normalized. Native ids,
    // geometry, props, state and ordering remain in the exact comparison.
    const normalize = value => {
      if (value === heading) return '<CONTROLLED_HEADING>';
      if (Array.isArray(value)) return value.map(normalize);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
      return value;
    };
    output.observations = normalize(output.observations);
  } finally {
    child.stdin.end();
    const kill = setTimeout(() => child.kill('SIGKILL'), 3000);
    const exit = await exited; clearTimeout(kill);
    if (exit.code !== 0) throw new Error(`Hermes shutdown failure: ${JSON.stringify(exit)} ${stderr}`);
  }
  if (stderr.trim()) throw new Error(`Unexpected Hermes diagnostics: ${stderr}`);
  return output;
}
