/**
 * @fantom_flags enableFabricCommitBranching:true
 */
import '@react-native/fantom/src/setUpDefaultReactNativeEnvironment';
import * as Fantom from '@react-native/fantom';
import * as React from 'react';
import {View} from 'react-native';
import {runContracts} from './shared';

it('emits shared observable native-host contracts', () => {
  const root = Fantom.createRoot({viewportWidth: 390, viewportHeight: 844, devicePixelRatio: 1});
  try {
    const cases = runContracts(React, {View}, {render: element => root.render(element), task: fn => Fantom.runTask(fn)});
    // Assertions stay outside React callbacks so component error handling cannot
    // swallow them. The external comparator validates the complete records.
    expect(cases.length).toBe(2);
    console.log('NH_CONTRACT_RESULT', JSON.stringify({schemaVersion: 1,
      runtime: {react: React.version, hermes: HermesInternal.getRuntimeProperties(), renderer: 'stock-rn-fantom', flags: {enableFabricCommitBranching: true}}, cases}));
  } finally { root.destroy(); }
});
