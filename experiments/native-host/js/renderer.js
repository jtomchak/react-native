import React from 'react';
import Reconciler from 'react-reconciler';
import {
  ConcurrentRoot,
  DefaultEventPriority,
  DiscreteEventPriority,
  ContinuousEventPriority,
} from 'react-reconciler/constants';

const context = Object.freeze({});
const container = {children: []};
let nextID = 1;
let revision = 0;
let priority = 0;
let dirty = false;
let geometry = null;
let mounted = {revision: 0, children: []};
const errors = [];
const fatalErrors = [];
const trace = [];
const pendingCommands = [];
let pendingCommandBytes = 0;
function recordTrace(event) {
  if (!__NH_TEST_HOOKS__) return;
  trace.push(event);
  if (trace.length > 128) trace.shift();
}
const types = new Set(['View', 'Text', 'Image', 'Pressable', 'ScrollView', 'TextInput', 'WebView']);

export const View = 'View';
export const Text = 'Text';
export const Image = 'Image';
export const Pressable = 'Pressable';
export const ScrollView = 'ScrollView';
export const TextInput = 'TextInput';
export const WebView = 'WebView';

function flattenStyle(style) {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
  return style && typeof style === 'object' ? style : {};
}

function serialProps(props) {
  const result = {};
  for (const key of Object.keys(props)) {
    if (key === 'children' || key === 'ref' || typeof props[key] === 'function') continue;
    if (key === 'style') result.style = flattenStyle(props.style);
    else if (props[key] !== undefined) result[key] = props[key];
  }
  return result;
}

function serialize(node) {
  const props = serialProps(node.props);
  if (node.type === 'TextInput') props.mostRecentEventCount = node.textEventCount;
  if (node.hidden) props.style = {...props.style, display: 'none'};
  return {id: node.id, type: node.type, props, children: node.children.map(serialize)};
}

function tree() { return {revision, children: container.children.map(serialize)}; }
function find(nodes, id) {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = find(node.children, id);
    if (child) return child;
  }
  return null;
}

function layout() {
  if (!geometry) geometry = JSON.parse(globalThis.__nhLayout(JSON.stringify(tree())));
  return geometry;
}

function command(node, name, args) {
  if (!find(container.children, node.id)) throw new Error('Cannot command an unmounted node');
  if (typeof globalThis.__nhCommand !== 'function') {
    throw new Error(`Unsupported native command in this backend: ${name}`);
  }
  const payload = JSON.stringify({version: 1, generation: globalThis.__nhGeneration, nodeId: node.id, name, args});
  if (dirty) {
    // Layout effects can run before the final native mount. Keep their commands
    // ordered, but never target an intermediate node/document that was replaced.
    const source = node.type === 'WebView' ? JSON.stringify(node.props.source) : undefined;
    const bytes = payload.length + (source?.length || 0);
    if (pendingCommands.length >= 256 || pendingCommandBytes + bytes > 1024 * 1024) throw new Error('Native command queue capacity exceeded');
    pendingCommands.push({nodeId: node.id, payload, source});
    pendingCommandBytes += bytes;
    recordTrace({kind: 'native-command-queued', nodeId: node.id, name});
  } else {
    globalThis.__nhCommand(payload);
    recordTrace({kind: 'native-command-dispatched', nodeId: node.id, name});
  }
}

function makeNode(type, props) {
  const node = {id: nextID++, type, props, children: [], hidden: false, textEventCount: 0};
  node.public = Object.freeze({
    id: node.id,
    getBoundingClientRect() {
      const current = find(layout().children, node.id);
      if (!current) return null;
      return {...current.bounds};
    },
    measure(callback) {
      const bounds = this.getBoundingClientRect();
      if (bounds) callback(bounds.x, bounds.y, bounds.width, bounds.height, bounds.x, bounds.y);
    },
    focus() { return command(node, 'focus', {}); },
    blur() { return command(node, 'blur', {}); },
    clear() { return command(node, 'clear', {}); },
    scrollTo({x = 0, y = 0, animated = true} = {}) {
      if (!Number.isFinite(x) || !Number.isFinite(y) || typeof animated !== 'boolean') throw new TypeError('scrollTo requires finite coordinates and a boolean animated option');
      return command(node, 'scrollTo', {x, y, animated});
    },
    scrollToEnd({animated = true} = {}) {
      if (typeof animated !== 'boolean') throw new TypeError('scrollToEnd requires a boolean animated option');
      return command(node, 'scrollToEnd', {animated});
    },
    reload() { return command(node, 'reload', {}); },
    goBack() { return command(node, 'goBack', {}); },
    goForward() { return command(node, 'goForward', {}); },
    stopLoading() { return command(node, 'stopLoading', {}); },
    postMessage(data) {
      if (typeof data !== 'string') throw new TypeError('postMessage requires a string');
      return command(node, 'postMessage', {data});
    },
    injectJavaScript(source) {
      if (typeof source !== 'string') throw new TypeError('injectJavaScript requires a string');
      return command(node, 'injectJavaScript', {source});
    },
  });
  return node;
}

function append(parent, child) {
  const index = parent.children.indexOf(child);
  if (index >= 0) parent.children.splice(index, 1);
  parent.children.push(child);
}
function insert(parent, child, before) {
  const old = parent.children.indexOf(child);
  if (old >= 0) parent.children.splice(old, 1);
  const index = parent.children.indexOf(before);
  if (index < 0) throw new Error('Missing insertion anchor');
  parent.children.splice(index, 0, child);
}
function remove(parent, child) {
  const index = parent.children.indexOf(child);
  if (index < 0) throw new Error('Removing missing child');
  parent.children.splice(index, 1);
}
function recordError(error) {
  errors.push(String(error && error.stack || error).slice(0, 4096));
  if (errors.length > 16) errors.shift();
}
function recordFatalError(error) {
  recordError(error);
  fatalErrors.push(String(error && error.message || error).slice(0, 4096));
  if (fatalErrors.length > 16) fatalErrors.shift();
}

export const reconciler = Reconciler({
  rendererVersion: '0.0.0',
  rendererPackageName: 'native-host-experiment',
  getPublicInstance: node => node.public,
  getRootHostContext: () => context,
  getChildHostContext: () => context,
  prepareForCommit: () => null,
  resetAfterCommit() {
    revision++;
    dirty = true;
    geometry = null;
    recordTrace({kind: 'react-commit', revision});
  },
  createInstance(type, props) {
    if (!types.has(type)) throw new Error(`Unsupported primitive: ${type}`);
    return makeNode(type, props);
  },
  createTextInstance: text => makeNode('#text', {text}),
  appendInitialChild: append,
  finalizeInitialChildren: () => false,
  shouldSetTextContent: () => false,
  scheduleTimeout: (...args) => setTimeout(...args),
  cancelTimeout: id => clearTimeout(id),
  noTimeout: -1,
  isPrimaryRenderer: true,
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  supportsMicrotasks: true,
  scheduleMicrotask: callback => queueMicrotask(callback),
  supportsTestSelectors: false,
  setCurrentUpdatePriority: value => { priority = value; },
  getCurrentUpdatePriority: () => priority,
  resolveUpdatePriority: () => priority || DefaultEventPriority,
  trackSchedulerEvent() {},
  resolveEventType: () => null,
  resolveEventTimeStamp: () => performance.now(),
  shouldAttemptEagerTransition: () => false,
  detachDeletedInstance() {},
  getInstanceFromNode: () => null,
  preparePortalMount() {},
  maySuspendCommit: () => false,
  maySuspendCommitOnUpdate: () => false,
  maySuspendCommitInSyncRender: () => false,
  preloadInstance: () => true,
  startSuspendingCommit() {},
  suspendInstance() {},
  suspendOnActiveViewTransition() {},
  waitForCommitToBeReady: () => null,
  getSuspendedCommitReason: () => null,
  NotPendingTransition: null,
  HostTransitionContext: React.createContext(null),
  resetFormInstance() {},
  bindToConsole: (method, args) => console[method].bind(console, ...args),
  appendChild: append,
  appendChildToContainer: append,
  insertBefore: insert,
  insertInContainerBefore: insert,
  removeChild: remove,
  removeChildFromContainer: remove,
  commitTextUpdate(node, _oldText, text) { node.props = {text}; },
  commitUpdate(node, _type, _oldProps, props) { node.props = props; },
  commitMount() {},
  resetTextContent(node) { node.children = []; },
  hideInstance(node) { node.hidden = true; },
  hideTextInstance(node) { node.hidden = true; },
  unhideInstance(node) { node.hidden = false; },
  unhideTextInstance(node) { node.hidden = false; },
  clearContainer(root) { root.children = []; },
});

const root = reconciler.createContainer(container, ConcurrentRoot, null, false,
  null, 'nh-', recordFatalError, recordError, recordError, () => {});

export function render(element) {
  reconciler.updateContainerSync(element, root, null, null);
  reconciler.flushSyncWork();
}

export function flushMount() {
  reconciler.flushSyncWork();
  // Passive effects are explicitly drained in this prototype host. They may
  // schedule another commit; no intermediate transaction is sent to UIKit.
  for (let i = 0; i < 100 && reconciler.flushPassiveEffects(); i++) reconciler.flushSyncWork();
  if (fatalErrors.length) {
    pendingCommands.length = 0;
    pendingCommandBytes = 0;
    throw new Error(fatalErrors.splice(0).join('\n'));
  }
  if (dirty) {
    mounted = JSON.parse(globalThis.__nhCommit(JSON.stringify(tree())));
    geometry = mounted;
    dirty = false;
    recordTrace({kind: 'native-mount', revision});
  }
  const commands = pendingCommands.splice(0);
  pendingCommandBytes = 0;
  for (const item of commands) {
    const current = find(container.children, item.nodeId);
    if (!current || !find(mounted.children, item.nodeId) ||
        (current.type === 'WebView' && JSON.stringify(current.props.source) !== item.source)) {
      recordTrace({kind: 'native-command-dropped', nodeId: item.nodeId, reason: 'target-replaced-before-mount'});
      continue;
    }
    globalThis.__nhCommand(item.payload);
    recordTrace({kind: 'native-command-dispatched', nodeId: item.nodeId});
  }
  return mounted;
}

const events = {
  press: 'onPress', changeText: 'onChangeText', submitEditing: 'onSubmitEditing', focus: 'onFocus', blur: 'onBlur',
  message: 'onMessage', navigation: 'onNavigationStateChange', load: 'onLoad',
  loadStart: 'onLoadStart', loadEnd: 'onLoadEnd', error: 'onError', scroll: 'onScroll',
};

export function dispatchEvent({nodeId, event, payload}) {
  const node = find(container.children, nodeId);
  if (!node) throw new Error(`Stale or unknown node: ${nodeId}`);
  if (node.props.disabled && event === 'press') return {delivered: false};
  const name = events[event];
  if (!name) throw new Error(`Unsupported event: ${event}`);
  if (event === 'changeText' && payload && typeof payload === 'object' && Object.hasOwn(payload, 'eventCount')) {
    if (node.type !== 'TextInput' || !Number.isSafeInteger(payload.eventCount) || payload.eventCount < 1) {
      throw new TypeError('TextInput eventCount must be a positive safe integer');
    }
    if (payload.eventCount <= node.textEventCount) return {delivered: false, reason: 'stale-text-event'};
    node.textEventCount = payload.eventCount;
    // Publish the acknowledgement even when a controlled handler rejects the
    // edit or React bails out of a same-value state update. Native adapters must
    // not apply an older JS value over newer input still queued for delivery.
    revision++;
    dirty = true;
    geometry = null;
  }
  const handler = node.props[name];
  if (typeof handler !== 'function') return {delivered: false};
  const previous = priority;
  priority = event === 'scroll' ? ContinuousEventPriority : DiscreteEventPriority;
  try {
    reconciler.batchedUpdates(() => handler(event === 'changeText'
      ? (typeof payload === 'string' ? payload : payload.text)
      : {nativeEvent: payload || {}, target: node.public, currentTarget: node.public}));
  } finally { priority = previous; }
  reconciler.flushSyncWork();
  return {delivered: true};
}

export function snapshot() { return mounted; }
export function rendererStatus() { return {revision, dirty, pendingCommands: pendingCommands.length, errors: [...errors], trace: [...trace]}; }
export function clearTrace() { trace.length = 0; }
globalThis.__nhFlushMount = flushMount;
