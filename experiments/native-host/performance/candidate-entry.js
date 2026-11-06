import React from 'react';
import * as Native from '../js/renderer.js';
import {createPerformanceScreen} from './workload.js';
import {REVISION} from './revision.js';

const Screen = createPerformanceScreen(React, Native);
globalThis.__nhDispatch = (method, params = {}) => {
  if (method === 'app.event') return Native.dispatchEvent(params);
  if (method === 'ui.snapshot' && __NH_TEST_HOOKS__) return Native.snapshot();
  throw new Error(`Unsupported performance fixture method: ${method}`);
};
Native.render(React.createElement(Screen, {revision: REVISION}));
