import {test, expect, nodeByID, textOf} from './host.mjs';

test('real native runtime reports its backend, not a Node substitute', async ({host}) => {
  const identity = await host.call('session.describe');
  expect(JSON.stringify(identity)).toMatch(/hermes/i);
  const answer = await host.call('runtime.eval', {source: 'typeof HermesInternal'});
  expect(answer).toBe('object');
});

test('React state updates through a headless event, explicitly not system input', async ({host}) => {
  let tree = await host.call('ui.snapshot');
  expect(textOf(nodeByID(tree, 'count-label'))).toBe('Count: 0');
  await host.call('app.event', {nodeId: nodeByID(tree, 'increment').id, event: 'press'});
  tree = await host.call('ui.snapshot');
  expect(textOf(nodeByID(tree, 'count-label'))).toBe('Count: 1');
});

test('keyboard submit delivers the native text to onSubmitEditing', async ({host}) => {
  await host.call('scenario.load', {name: 'submit-editing'});
  const input = nodeByID(await host.call('ui.snapshot'), 'submit-input');
  await host.call('app.event', {nodeId: input.id, event: 'submitEditing', payload: {text: 'Native ✓'}});
  expect(await host.call('scenario.result')).toEqual({submitted: ['Native ✓']});
});

test('controlled text acknowledges ordered native edits and drops stale events', async ({host}) => {
  await host.call('scenario.load', {name: 'controlled-text'});
  const input = () => host.call('ui.snapshot').then(tree => nodeByID(tree, 'controlled-text'));
  const node = await input();
  expect(node.props.mostRecentEventCount).toBe(0);
  for (const [eventCount, text] of [[1, 'a'], [3, 'abc'], [2, 'ab'], [3, 'duplicate']]) {
    await host.call('app.event', {nodeId: node.id, event: 'changeText', payload: {eventCount, text}});
  }
  expect((await input()).props).toMatchObject({value: 'abc', mostRecentEventCount: 3});
  expect(await host.call('scenario.result')).toEqual({received: ['a', 'abc']});
});

for (const name of ['controlled-text-reject', 'controlled-text-no-handler']) {
  test(`controlled text publishes native acknowledgement without a React state change: ${name}`, async ({host}) => {
    await host.call('scenario.load', {name});
    const node = nodeByID(await host.call('ui.snapshot'), 'controlled-text');
    await host.call('app.event', {nodeId: node.id, event: 'changeText', payload: {eventCount: 1, text: 'rejected edit'}});
    expect(nodeByID(await host.call('ui.snapshot'), 'controlled-text').props)
      .toMatchObject({value: 'seed', mostRecentEventCount: 1});
  });
}

// A command recorder isolates JS queuing. These are not platform action tests;
// native validation lives in CTest and real input/scroll/WebView device tests.
async function installCommandRecorder(host) {
  await host.call('runtime.eval', {source: `
    globalThis.__recordedCommands = [];
    globalThis.__commandMountedTree = null;
    const originalCommit = globalThis.__nhCommit;
    globalThis.__nhCommit = raw => {
      const result = originalCommit(raw);
      globalThis.__commandMountedTree = JSON.parse(result);
      return result;
    };
    globalThis.__nhCommand = raw => {
      const request = JSON.parse(raw);
      const contains = nodes => nodes.some(node => node.id === request.nodeId || contains(node.children));
      if (!__commandMountedTree || !contains(__commandMountedTree.children)) throw Error('Command preceded native mount');
      __recordedCommands.push({...request, mountedRevision: __commandMountedTree.revision});
      return null;
    };`});
}

test('layout-effect commands wait for the final native mount and retain order', async ({host}) => {
  await installCommandRecorder(host);
  await host.call('scenario.load', {name: 'command-queue'});
  const calls = await host.call('runtime.eval', {source: '__recordedCommands'});
  const {ids} = await host.call('scenario.result');
  expect(calls.map(item => item.nodeId)).toEqual(ids);
  expect(calls.map(item => item.name)).toEqual(['focus', 'focus']);
  expect(calls.every(item => item.version === 1 && item.generation > 0)).toBe(true);
  expect(new Set(calls.map(item => item.mountedRevision)).size).toBe(1);
  expect((await host.call('runtime.status')).renderer.pendingCommands).toBe(0);
});

for (const name of ['command-replace', 'command-document-replace']) {
  test(`queued commands cannot reach a replaced target: ${name}`, async ({host}) => {
    await installCommandRecorder(host);
    await host.call('scenario.load', {name});
    const calls = await host.call('runtime.eval', {source: '__recordedCommands'});
    const {ids} = await host.call('scenario.result');
    expect(calls).toHaveLength(1);
    expect(calls[0].nodeId).toBe(ids[1]);
    if (name === 'command-document-replace') expect(calls[0].args.source).toBe('window.commandStep=1');
    expect((await host.call('runtime.status')).renderer.trace.filter(item => item.kind === 'native-command-dropped')).toHaveLength(1);
  });
}

test('layout-effect cascades expose measured committed geometry but publish one final mount', async ({host}) => {
  await host.call('trace.clear');
  await host.call('scenario.load', {name: 'atomic-layout'});
  const result = await host.call('scenario.result');
  expect(result.effects).toEqual([0, 1]);
  expect(result.geometry.map(rect => rect.width)).toEqual([60, 120]);
  const status = await host.call('runtime.status');
  expect(status.renderer.trace.filter(item => item.kind === 'native-mount')).toHaveLength(1);
  expect(nodeByID(await host.call('ui.snapshot'), 'atomic').bounds.width).toBe(120);
});

test('keyed reorder preserves state and native identity', async ({host}) => {
  await host.call('scenario.load', {name: 'keyed'});
  const before = await host.call('scenario.result');
  await host.call('app.event', {nodeId: before.ids.a, event: 'press'});
  await host.call('scenario.action');
  await host.call('runtime.pump');
  const after = await host.call('scenario.result');
  expect(after.ids).toEqual(before.ids);
  const tree = await host.call('ui.snapshot');
  expect(tree.children[0].children.map(node => node.props.testID)).toEqual(['b', 'a']);
  expect(textOf(nodeByID(tree, 'a'))).toBe('a!');
});

test('unmount runs layout and passive cleanup and rejects stale node events', async ({host}) => {
  await host.call('scenario.load', {name: 'cleanup'});
  const before = await host.call('scenario.result');
  expect(before.effectSetup).toBe(1);
  await host.call('app.unmount');
  expect(await host.call('scenario.result')).toMatchObject({layoutCleanup: 1, effectCleanup: 1});
  await expect(host.call('app.event', {nodeId: before.refID, event: 'press'})).rejects.toThrow(/Stale/);
  expect((await host.call('ui.snapshot')).children).toEqual([]);
});

test('reset props removes stale geometry and accessibility state', async ({host}) => {
  await host.call('scenario.load', {name: 'prop-reset'});
  expect(nodeByID(await host.call('ui.snapshot'), 'props').bounds.width).toBe(50);
  await host.call('scenario.action');
  await host.call('runtime.pump');
  const node = nodeByID(await host.call('ui.snapshot'), 'props');
  expect(node.bounds.width).toBe(200);
  expect(node.bounds.x).toBe(0);
  expect(node.props.accessibilityLabel).toBeUndefined();
});

test('suspended concurrent work cannot replace committed event handlers', async ({host}) => {
  await host.call('scenario.load', {name: 'interrupted'});
  await host.call('scenario.action');
  // Drain scheduler turns without resolving the suspended transition.
  for (let i = 0; i < 4; i++) await host.call('runtime.pump');
  const node = nodeByID(await host.call('ui.snapshot'), 'handler');
  expect(textOf(node)).toBe('committed');
  await host.call('app.event', {nodeId: node.id, event: 'press'});
  expect((await host.call('scenario.result')).handlers).toEqual(['committed']);
});

test('Rust worker echo settles a Hermes promise with Unicode and embedded NUL', async ({host}) => {
  const payload = 'Rust → Hermes \u0000 ✓';
  const {id} = await host.call('services.echo', {payload, delay: 5});
  const result = await host.wait('services.result', {id}, value => value.state !== 'pending');
  expect(result).toEqual({state: 'success', value: payload});
});

test('winning cancellation rejects once and suppresses late native completion', async ({host}) => {
  const {id} = await host.call('services.echo', {payload: 'late', delay: 1000});
  await host.call('services.cancel', {id});
  const result = await host.wait('services.result', {id}, value => value.state !== 'pending');
  expect(result).toMatchObject({state: 'error', code: 'CANCELLED'});
  await host.call('services.cancel', {id});
  const status = await host.call('runtime.status');
  expect(status.services.deliveries.filter(event => event.id === id && event.kind === 'request')).toHaveLength(1);
});

test('subscriptions return through Hermes and unsubscribe is idempotent', async ({host}) => {
  const {id} = await host.call('services.subscribe');
  await host.call('services.publish', {id, payload: 'first'});
  expect(await host.call('services.events')).toEqual([{id, value: 'first'}]);
  await host.call('services.unsubscribe', {id});
  await host.call('services.unsubscribe', {id});
  await expect(host.call('services.publish', {id, payload: 'late'})).rejects.toThrow(/Unknown subscription/);
});

test('headless backend refuses browser and system-input claims', async ({host}) => {
  await expect(host.call('webview.attach', {testID: 'web-primary'})).rejects.toThrow(/UNSUPPORTED/);
  await expect(host.call('ui.perform', {testID: 'increment', action: 'tap'})).rejects.toThrow(/UNSUPPORTED/);
});

test('React error boundary mounts its fallback after recovery', async ({host}) => {
  await host.call('scenario.load', {name: 'error-boundary'});
  expect(textOf(nodeByID(await host.call('ui.snapshot'), 'fallback'))).toBe('Recovered');
  expect(await host.call('scenario.result')).toEqual({caught: 1});
});

test('unexpected asynchronous failures fail the runner instead of becoming a green pump', async ({host}) => {
  await host.call('runtime.eval', {source: "setTimeout(() => { throw new Error('ASYNC_TEST_SENTINEL'); }, 0)"});
  await expect(host.call('runtime.pump')).rejects.toThrow(/ASYNC_TEST_SENTINEL/);
  await expect(host.call('runtime.pump')).rejects.toThrow(/ASYNC_TEST_SENTINEL/);
  expect(await host.call('runtime.ackErrors')).toEqual({acknowledged: 1});
});

test('native asynchronous errors reject the Hermes promise with operation diagnostics', async ({host}) => {
  const {id} = await host.call('services.error', {payload: 'echo: deliberately failed', delay: 1});
  const result = await host.wait('services.result', {id}, value => value.state !== 'pending');
  expect(result).toEqual({state: 'error', code: 'NATIVE_ERROR', message: 'echo: deliberately failed'});
});

test('diagnostic service history is bounded and does not retain payloads', async ({host}) => {
  for (let i = 0; i < 140; i++) {
    const {id} = await host.call('services.echo', {payload: 'memory-sensitive-payload'});
    await host.wait('services.result', {id}, value => value.state !== 'pending');
  }
  const {services} = await host.call('runtime.status');
  expect(services.deliveries).toHaveLength(128);
  expect(services.deliveries.every(item => !Object.hasOwn(item, 'payload'))).toBe(true);
});
