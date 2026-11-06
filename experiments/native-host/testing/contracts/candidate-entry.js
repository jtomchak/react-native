import React from 'react';
import {View, render, reconciler, flushMount, rendererStatus} from '../../js/renderer.js';
import {runContracts} from './shared.js';

globalThis.__nhDispatch = method => {
  if (method !== 'contracts.run') throw new Error(`Unknown contract method: ${method}`);
  const cases = runContracts(React, {View}, {
    render,
    task(fn) { reconciler.flushSyncFromReconciler(fn); flushMount(); },
  });
  const errors = rendererStatus().errors;
  if (errors.length) throw new Error(JSON.stringify(errors));
  return {schemaVersion: 1, runtime: {react: React.version, hermes: HermesInternal.getRuntimeProperties(), renderer: 'candidate'}, cases};
};
