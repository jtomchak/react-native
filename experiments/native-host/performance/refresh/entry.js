import React from 'react';
import * as Native from '../../js/renderer.js';
import {attachRefreshRenderer} from '../../js/dev/renderer-bootstrap.js';
import PerformanceScreen from './application/PerformanceScreen.jsx';

attachRefreshRenderer(Native.reconciler);
globalThis.__nhDispatch = (method, params = {}) => {
  if (method === 'app.event') return Native.dispatchEvent(params);
  throw new Error(`Unsupported performance method: ${method}`);
};
Native.render(React.createElement(PerformanceScreen));
