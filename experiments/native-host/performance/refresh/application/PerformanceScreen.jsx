import React from 'react';
import Screen from '../BoundPerformanceScreen.js';
import {REVISION} from './revision.js';

export default function PerformanceScreen() {
  return <Screen revision={REVISION} />;
}
