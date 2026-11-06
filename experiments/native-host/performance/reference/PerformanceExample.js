import * as React from 'react';
import PerformanceScreen from './BoundPerformanceScreen';
import {REVISION} from './revision';

// A component-only export gives ordinary Metro Fast Refresh a local boundary.
// RNTester's mixed metadata exports live in the importing module.
export default function PerformanceExample() {
  return React.createElement(PerformanceScreen, {revision: REVISION});
}
