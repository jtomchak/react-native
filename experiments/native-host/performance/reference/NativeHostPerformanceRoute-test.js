import {create, unmount} from '@react-native/jest-preset/jest/renderer';
import * as React from 'react';
import TestRenderer from 'react-test-renderer';

jest.mock('../components/RNTesterModuleList', () => {
  const actual = jest.requireActual('../components/RNTesterModuleList');
  const React = require('react');
  // Observe render attempts while still rendering the actual memoized menu.
  return jest.fn(props => React.createElement(actual, props));
});

// Full RNTester intentionally imports deprecated internal interfaces. The root
// Jest preset throws for every warning; permit only that existing import notice,
// never runtime/component errors or arbitrary warnings.
const originalWarn = console.warn;
const importWarnings = [];
const {Image} = require('react-native');
// ImageExample starts prefetch while the full list loads. The stock Jest mock
// returns undefined; honor the real Promise contract without network I/O.
jest.spyOn(Image, 'prefetch').mockResolvedValue(true);
jest.spyOn(console, 'warn').mockImplementation((...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith("Deep imports from the 'react-native' package are deprecated")) {
    importWarnings.push(args[0]);
    return;
  }
  originalWarn(...args);
});
const RNTesterApp = require('../RNTesterAppShared').default;
const RNTesterList = require('../utils/RNTesterList');
const {getInitialStateFromLaunchRoute} = require('../utils/initialNavigationStateFromLaunch');
const menuRender = require('../components/RNTesterModuleList');
const {REVISION} = require('../examples/NativeHostPerformance/revision');
afterAll(() => { console.warn.mockRestore(); Image.prefetch.mockRestore(); });

it('retains the original RNTester module graph alongside the performance module', () => {
  expect(require('react-native').Platform.OS).toBe(process.env.NH_REFERENCE_TEST_PLATFORM);
  expect(RNTesterList.Components.length).toBeGreaterThan(20);
  expect(RNTesterList.APIs.length).toBeGreaterThan(20);
  expect(RNTesterList.Modules.NativeHostPerformanceExample).toBeDefined();
  expect(RNTesterList.Modules.ViewExample).toBeDefined();
});

it('native route initial prop renders the actual workload before initial deep-link resolution', async () => {
  menuRender.mockClear();
  const renderer = await create(<RNTesterApp exampleFromAppetizeParams="rntester://example/NativeHostPerformanceExample" />);
  try {
    expect(menuRender).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({testID: 'perf-revision'}).props.children).toBe(`Revision: ${REVISION}`);
    expect(renderer.root.findByProps({testID: 'perf-mounted'}).props.children).toBe('Rows: 100');
    expect(renderer.root.findByProps({testID: 'perf-row-99'})).toBeDefined();
    await TestRenderer.act(() => renderer.root.findByProps({testID: 'perf-update'}).props.onPress());
    expect(renderer.root.findByProps({testID: 'perf-state'}).props.children).toBe('Count: 1; order: forward');
    await TestRenderer.act(() => renderer.root.findByProps({testID: 'perf-toggle'}).props.onPress());
    expect(renderer.root.findByProps({testID: 'perf-mounted'}).props.children).toBe('Rows: 0');
    expect(renderer.root.findAllByProps({testID: 'perf-row-99'})).toHaveLength(0);
  } finally { await unmount(renderer); }
});

it('normal no-route startup still renders the real Components menu', async () => {
  menuRender.mockClear();
  const renderer = await create(<RNTesterApp />);
  try {
    expect(menuRender).toHaveBeenCalled();
    expect(renderer.root.findAllByProps({testID: 'perf-revision'})).toHaveLength(0);
  } finally { await unmount(renderer); }
});

it('normal startup still selects Components and invalid launch routes fail explicitly', () => {
  expect(getInitialStateFromLaunchRoute(undefined)).toMatchObject({screen: 'components', activeModuleKey: null});
  expect(() => getInitialStateFromLaunchRoute('rntester://example/missing-module')).toThrow(/Unknown/);
  expect(() => getInitialStateFromLaunchRoute('rntester://example/NativeHostPerformanceExample/missing')).toThrow(/Unknown/);
});
