import React from 'react';
import * as Native from '../../js/renderer.js';
import {createPerformanceScreen} from '../workload.js';

// Permanent factory binding: revision updates must not recreate this stateful
// component. The shared workload source remains unchanged.
export default createPerformanceScreen(React, Native);
