import React from 'react';
import {Demo} from './app.jsx';
import {clearTrace, dispatchEvent, render, rendererStatus, snapshot} from './renderer.js';
import {echo, echoErrorForTest, serviceStatus, subscribe} from './services.js';
import {loadScenario, scenarioAction, scenarioResult} from './scenarios.jsx';

const results = new Map();
const channels = new Map();
const channelEvents = [];

globalThis.__nhDispatch = (method, params = {}) => {
  if (method === 'app.event') return dispatchEvent(params);
  if (!__NH_TEST_HOOKS__) throw new Error('Test protocol requires a test build');
  switch (method) {
    case 'app.demo': render(<Demo />); return {rendered: true};
    case 'app.unmount': render(null); return {unmounted: true};
    case 'ui.snapshot': return snapshot();
    case 'runtime.status': return {renderer: rendererStatus(), services: serviceStatus()};
    case 'diagnostics.capture': return {snapshot: snapshot(), renderer: rendererStatus(), services: serviceStatus()};
    case 'trace.clear': clearTrace(); return {};
    case 'scenario.load': loadScenario(params.name); return {name: params.name};
    case 'scenario.action': return scenarioAction();
    case 'scenario.result': return scenarioResult();
    case 'services.error':
    case 'services.echo': {
      if (results.size >= 256) {
        const settled = [...results].find(([, value]) => value.state !== 'pending');
        if (!settled) throw new Error('Test result capacity exceeded');
        results.delete(settled[0]);
      }
      const request = (method === 'services.error' ? echoErrorForTest : echo)(params.payload, params.delay || 0);
      results.set(request.id, {state: 'pending'});
      request.promise.then(
        value => results.set(request.id, {state: 'success', value}),
        error => results.set(request.id, {state: 'error', code: error.code, message: error.message}),
      );
      return {id: request.id};
    }
    case 'services.cancel': return {status: globalThis.__nhCancel(params.id)};
    case 'services.result': {
      if (!results.has(params.id)) throw new Error('Unknown request');
      return results.get(params.id);
    }
    case 'services.subscribe': {
      const channel = subscribe(value => {
        channelEvents.push({id: channel.id, value: value.slice(0, 1024)});
        if (channelEvents.length > 64) channelEvents.shift();
      });
      channels.set(channel.id, channel);
      return {id: channel.id};
    }
    case 'services.publish': {
      const channel = channels.get(params.id);
      if (!channel) throw new Error('Unknown subscription');
      return {status: channel.publish(params.payload)};
    }
    case 'services.unsubscribe': {
      const channel = channels.get(params.id);
      if (!channel) return {alreadyRemoved: true};
      const status = channel.unsubscribe();
      channels.delete(params.id);
      return {status};
    }
    case 'services.events': return [...channelEvents];
    case 'webview.attach': throw new Error('UNSUPPORTED: headless host has no browser; use a platform DOM adapter');
    case 'ui.perform': throw new Error('UNSUPPORTED: headless event injection is not system input; use platform automation');
    case 'fixture.reset': throw new Error('Reset by creating a new host process/generation; in-place reset not implemented');
    default: throw new Error(`Unsupported protocol method: ${method}`);
  }
};

render(<Demo />);
