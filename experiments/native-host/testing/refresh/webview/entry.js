import React from 'react';
import * as Native from '../../../js/renderer.js';
import {attachRefreshRenderer} from '../../../js/dev/renderer-bootstrap.js';
import Screen from './application/Screen.jsx';

attachRefreshRenderer(Native.reconciler);
globalThis.__nhDispatch = (method, params = {}) => {
  if (method === 'app.event') return Native.dispatchEvent(params);
  throw new Error(`Unsupported browser Refresh method: ${method}`);
};
Native.render(React.createElement(Screen));
