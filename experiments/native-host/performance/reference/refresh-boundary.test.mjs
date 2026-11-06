import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const here = fileURLToPath(new URL('./', import.meta.url));
const root = path.resolve(here, '../..');
const reference = path.join(root, 'build/reference');
const require = createRequire(path.join(reference, 'package.json'));
const Refresh = require('react-refresh/runtime');
Refresh.injectIntoGlobalHook(globalThis);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.IS_REACT_NATIVE_TEST_ENVIRONMENT = true;
const React = require('react');
const Renderer = require('react-test-renderer');
const Babel = require('@babel/core');
const commonjs = require('@babel/plugin-transform-modules-commonjs');
const metroLoader = await readFile(path.join(reference, 'node_modules/metro-runtime/src/polyfills/require.js'), 'utf8');
const workload = await readFile(path.join(root, 'performance/workload.js'), 'utf8');
const source = Object.fromEntries(await Promise.all(['NativeHostPerformanceExample.js', 'BoundPerformanceScreen.js', 'PerformanceExample.js'].map(async name => [name, await readFile(path.join(here, name), 'utf8')])));
const legacyAdapter = `
import * as React from 'react';
import {View,Text,Image,Pressable,TextInput,ScrollView} from 'react-native';
import {createPerformanceScreen} from './workload';
import {REVISION} from './revision';
const Screen=createPerformanceScreen(React,{View,Text,Image,Pressable,TextInput,ScrollView});
export const title='Native Host Performance';
export const description='mixed metadata module';
export const examples=[{render:function PerformanceExample(){return React.createElement(Screen,{revision:REVISION});}}];`;

function factory(code) {
  const transformed = Babel.transformSync(code, {babelrc: false, configFile: false, plugins: [commonjs]}).code;
  return new Function('global', 'metroRequire', 'importDefault', 'importAll', 'module', 'exports', 'dependencyMap',
    `const require = name => metroRequire(dependencyMap[name]);\n${transformed}`);
}
async function exercise(mode) {
  const timers = [];
  const reloads = [];
  const prefix = `native_host_refresh_${mode}_`;
  const context = {__DEV__: true, __METRO_GLOBAL_PREFIX__: prefix, console,
    setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {},
    [prefix + '__SYSTRACE']: {beginEvent() {}, endEvent() {}},
    [prefix + '__requireCycleIgnorePatterns']: [],
    [prefix + '__ReactRefresh']: {...Refresh, performFullRefresh(reason) { reloads.push(reason); }}};
  vm.runInNewContext(`(function(global){${metroLoader}\n})(globalThis);`, context);
  const define = context[prefix + '__d'];
  define((g, r, i, a, module) => { module.exports = React; }, 1, [], 'react');
  define((g, r, i, a, module) => {
    module.exports = Object.fromEntries(['View','Text','Image','Pressable','TextInput','ScrollView'].map(name => [name, name]));
  }, 2, [], 'native-test-primitives');
  define(factory(workload), 3, {}, 'unchanged-shared-workload');
  define(factory("export const REVISION='before';"), 4, {}, 'revision');
  let inverse;
  if (mode === 'legacy') {
    define(factory(legacyAdapter), 7, {'react': 1, 'react-native': 2, './workload': 3, './revision': 4}, 'legacy-mixed-adapter');
    inverse = {4: [7], 7: [8], 8: []};
  } else {
    define(factory(source['BoundPerformanceScreen.js']), 5, {'react': 1, 'react-native': 2, './workload': 3}, 'stable-bound-screen');
    define(factory(source['PerformanceExample.js']), 6, {'react': 1, './BoundPerformanceScreen': 5, './revision': 4}, 'component-only-wrapper');
    define(factory(source['NativeHostPerformanceExample.js']), 7, {'./PerformanceExample': 6}, 'mixed-rntester-metadata');
    inverse = {4: [6], 6: [7], 7: [8], 8: []};
  }
  // An accepting parent component models a favorable RNTester parent boundary.
  // The legacy fixture must still reveal its nested-type state reset here.
  define(factory(`import * as React from 'react';import {examples} from './metadata';export default function Root(){return React.createElement(examples[0].render);}`),
    8, {'react': 1, './metadata': 7}, 'root-component');
  const Root = context.__r(8).default;
  const initialScreen = mode === 'split' ? context.__r(5).default : null;
  let renderer;
  const props = id => renderer.root.findByProps({testID: id}).props;
  try {
    await Renderer.act(() => { renderer = Renderer.create(React.createElement(Root)); });
    await Renderer.act(() => { props('perf-update').onPress(); props('perf-input').onChangeText('preserved'); });
    assert.equal(props('perf-state').children, 'Count: 1; order: forward');
    const stages = [];
    for (const revision of ['after-one', 'after-two']) {
      await Renderer.act(() => {
        context.__accept(4, factory(`export const REVISION=${JSON.stringify(revision)};`), {}, inverse);
        while (timers.length) timers.shift()();
      });
      stages.push({revision: props('perf-revision').children, state: props('perf-state').children,
        input: props('perf-input-value').children});
    }
    return {stages, reloads, stableScreenIdentity: mode === 'split' ? context.__r(5).default === initialScreen : null};
  } finally { if (renderer) await Renderer.act(() => renderer.unmount()); }
}

const evidence = {schemaVersion: 1, mechanism: 'actual installed Metro module loader + React Refresh runtime + React test renderer',
  versions: {react: React.version, metroRuntime: require('metro-runtime/package.json').version, reactRefresh: require('react-refresh/package.json').version},
  limitations: ['Host-side native primitives are test strings. This tests actual Refresh propagation/state behavior, not device HMR connection, PID stability, or edit-visible latency.',
    'Source uses normal CommonJS import lowering with no synthetic Refresh registrations, matching the absence of Babel Refresh instrumentation observed in the running Metro bundle.'], cases: {}};
await test('legacy mixed metadata/factory loses seeded state during revision Refresh', async () => {
  const result = evidence.cases.legacy = await exercise('legacy');
  assert.deepEqual(result.reloads, []);
  assert.equal(result.stages[0].revision, 'Revision: after-one');
  assert.equal(result.stages[0].state, 'Count: 0; order: forward');
  assert.equal(result.stages[0].input, 'Input: seed');
});
await test('component-only revision boundary preserves state on two actual Metro hot updates', async () => {
  const result = evidence.cases.split = await exercise('split');
  assert.deepEqual(result.reloads, []);
  assert.equal(result.stableScreenIdentity, true);
  assert.deepEqual(result.stages, ['after-one', 'after-two'].map(revision => ({revision: `Revision: ${revision}`, state: 'Count: 1; order: forward', input: 'Input: preserved'})));
});
await writeFile(path.join(root, 'build/reference-refresh-boundary-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
