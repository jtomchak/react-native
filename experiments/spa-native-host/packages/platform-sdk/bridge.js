(function installPlatform(global) {
  'use strict';
  if (global.platform && global.platform.protocolVersion === 1) return;

  const MAX_PENDING = 64;
  const MAX_IDS = 4096;
  const MAX_WIRE = 128 * 1024;
  const MAX_ANALYTICS_PENDING = 8;
  const listeners = new Map();
  const nativeSubscriptions = new Map();
  const coreEvents = new Set(['toolbar.action', 'navigation.back']);
  const externalEvents = new Set(['navigation.changed', 'chrome.tabSelected', 'links.opened', 'notifications.token', 'notifications.received', 'notifications.opened']);
  // Filled only by the build-time registry, before the API becomes immutable.
  const pluginFactories = [/* NATIVE_HOST_PLUGIN_FACTORIES */];
  const pluginDescriptors = [/* NATIVE_HOST_PLUGIN_DESCRIPTORS */];
  const pluginActions = new Set();
  const pluginTimeouts = new Map();
  const eventNormalizers = new Map();
  if (pluginFactories.length !== pluginDescriptors.length) throw new Error('Invalid plug-in registry');
  for (const descriptor of pluginDescriptors) {
    for (const action of descriptor.actions) { pluginActions.add(action.name); pluginTimeouts.set(action.name, action.timeoutMs); }
    for (const event of descriptor.events) externalEvents.add(event);
  }
  const pending = new Map();
  const encoder = new TextEncoder();
  let documentID = nonce();
  let session = null;
  let sequence = 0;
  let analyticsSequence = 0;
  let readyPromise = null;
  let stopped = false;
  let semanticActive = false;
  let semanticEpoch = 0;
  let semanticPending = 0;

  class PlatformError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'PlatformError';
      this.code = code;
    }
  }

  function nonce() {
    const bytes = new Uint8Array(16);
    if (global.crypto && global.crypto.getRandomValues) global.crypto.getRandomValues(bytes);
    else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function error(code, message) { return new PlatformError(code, message); }
  function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
  function identifier(value) { return typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[\x21-\x7e]+$/.test(value); }

  function transport() {
    const candidate = global.__SPA_TRANSPORT__;
    if (!candidate || typeof candidate.postMessage !== 'function') throw error('UNAVAILABLE', 'Native host is not available in this browser.');
    return candidate;
  }

  function post(message) {
    let json;
    try { json = JSON.stringify(message); }
    catch { throw error('INVALID_REQUEST', 'Arguments must be JSON serializable.'); }
    if (encoder.encode(json).byteLength > MAX_WIRE) throw error('QUOTA_EXCEEDED', 'Request exceeds the bridge message limit.');
    try { transport().postMessage(json); }
    catch (cause) {
      if (cause instanceof PlatformError) throw cause;
      throw error('UNAVAILABLE', 'Native transport could not send the request.');
    }
  }

  function cancelRemote(id) {
    const analytics = pending.get(id)?.action.startsWith('analytics.');
    if (!session || (analytics ? analyticsSequence >= Number.MAX_SAFE_INTEGER : sequence >= MAX_IDS)) return;
    try {
      const nextID = analytics ? `${documentID}-a${++analyticsSequence}` : `${documentID}-${++sequence}`;
      post({v: 1, id: nextID, document: documentID, session, action: 'cancel', args: {requestId: id}});
    } catch { /* Local settlement is authoritative even when the host is gone. */ }
  }

  function settle(id, outcome, value) {
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id);
    clearTimeout(item.timer);
    if (item.signal && item.abort) item.signal.removeEventListener('abort', item.abort);
    item[outcome](value);
  }

  function request(action, args, options) {
    if (stopped) return Promise.reject(error('UNAVAILABLE', 'Platform SDK has been disposed.'));
    if (options.signal && options.signal.aborted) return Promise.reject(error('CANCELLED', 'Request was cancelled.'));
    if (!identifier(action) || !object(args)) return Promise.reject(error('INVALID_REQUEST', 'Action and argument object are required.'));
    const interactive = ['camera.capture', 'share.present', 'biometrics.authenticate', 'notifications.requestPermission', 'notifications.register'].includes(action);
    const defaultTimeout = pluginTimeouts.get(action) ?? (interactive ? 120000 : 15000);
    const timeoutMs = options.timeoutMs === undefined ? defaultTimeout : options.timeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) return Promise.reject(error('INVALID_REQUEST', 'Timeout must be an integer between 1 and 120000 milliseconds.'));
    const analytics = action.startsWith('analytics.');
    if (pending.size >= MAX_PENDING || (analytics ? analyticsSequence >= Number.MAX_SAFE_INTEGER : sequence >= MAX_IDS)) return Promise.reject(error('QUOTA_EXCEEDED', 'Bridge request capacity exceeded. Reload this document.'));
    const id = analytics ? `${documentID}-a${++analyticsSequence}` : `${documentID}-${++sequence}`;
    return new Promise((resolve, reject) => {
      const item = {resolve, reject, signal: options.signal, timer: null, abort: null, action};
      item.timer = setTimeout(() => {
        cancelRemote(id);
        settle(id, 'reject', error('TIMEOUT', `${action} timed out.`));
      }, timeoutMs);
      if (item.signal) {
        item.abort = () => {
          cancelRemote(id);
          settle(id, 'reject', error('CANCELLED', 'Request was cancelled.'));
        };
        item.signal.addEventListener('abort', item.abort, {once: true});
      }
      pending.set(id, item);
      try { post({v: 1, id, document: documentID, session: action === 'hello' ? null : session, action, args}); }
      catch (cause) { settle(id, 'reject', cause); }
    });
  }

  function ready() {
    if (stopped) return Promise.reject(error('UNAVAILABLE', 'Platform SDK has been disposed.'));
    if (!readyPromise) readyPromise = request('hello', {}, {}).then(result => {
      if (!object(result) || !['ios', 'android'].includes(result.platform) || !Array.isArray(result.capabilities) || result.capabilities.length > 64 || !result.capabilities.every(identifier)) {
        session = null;
        throw error('INVALID_REQUEST', 'Native hello response is invalid.');
      }
      let host;
      if (result.host !== undefined) {
        const value = result.host;
        if (!object(value) || value.apiVersion !== 2 || !['packaged', 'hosted'].includes(value.contentMode) || !['web', 'native'].includes(value.navigationMode) || !['standard', 'tabs', 'adaptive'].includes(value.chromeMode) || !identifier(value.surfaceId) || !identifier(value.activeTab)) {
          session = null;
          throw error('INVALID_REQUEST', 'Native host metadata is invalid.');
        }
        host = Object.freeze({apiVersion: value.apiVersion, contentMode: value.contentMode, navigationMode: value.navigationMode, chromeMode: value.chromeMode, surfaceId: value.surfaceId, activeTab: value.activeTab});
      }
      return Object.freeze({platform: result.platform, capabilities: Object.freeze([...result.capabilities]), ...(host ? {host} : {})});
    });
    return readyPromise;
  }

  async function waitUntilReady(options = {}) {
    if (!object(options) || (options.signal && (typeof options.signal.addEventListener !== 'function' || typeof options.signal.removeEventListener !== 'function'))) throw error('INVALID_REQUEST', 'Invalid request options.');
    if (options.signal && options.signal.aborted) throw error('CANCELLED', 'Request was cancelled.');
    if (!options.signal) return ready();
    return new Promise((resolve, reject) => {
      const abort = () => reject(error('CANCELLED', 'Request was cancelled.'));
      options.signal.addEventListener('abort', abort, {once: true});
      ready().then(value => { options.signal.removeEventListener('abort', abort); resolve(value); }, cause => { options.signal.removeEventListener('abort', abort); reject(cause); });
    });
  }

  async function call(action, args = {}, options = {}) {
    if (action === 'hello' || action === 'cancel') throw error('INVALID_REQUEST', 'Action is reserved for the SDK.');
    const hello = await waitUntilReady(options);
    if (pluginActions.has(action) && !hello.capabilities.includes(action)) throw error('UNSUPPORTED', 'This native plug-in action is not available in this host.');
    return request(action, args, options);
  }

  async function analyticsCall(action, args = {}, options = {}) {
    const hello = await ready();
    if (!hello.capabilities.includes(action)) throw error('UNSUPPORTED', 'Native analytics is not available in this host.');
    return call(action, args, options);
  }

  async function analyticsTrack(name, properties = {}) {
    if (typeof name !== 'string' || !/^custom\.[a-z0-9_.]{1,57}$/.test(name) || !object(properties)) throw error('INVALID_REQUEST', 'A custom semantic analytics name and safe properties are required.');
    const enums = {screen: ['overview', 'compose', 'library', 'hosted', 'unknown'], kind: ['button', 'link', 'input', 'select', 'form', 'other'], outcome: ['ok', 'error', 'cancelled', 'unavailable'], state: ['started', 'foreground', 'background', 'selected', 'committed', 'failed', 'disposed'], presentation: ['push', 'replace', 'modal', 'pop', 'web']};
    const safe = {};
    for (const key of Object.keys(properties)) {
      const value = properties[key];
      const valid = Object.prototype.hasOwnProperty.call(enums, key) ? enums[key].includes(value) : ['action', 'control', 'tab', 'code'].includes(key) ? typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) : ['count', 'durationMs'].includes(key) && Number.isInteger(value) && value >= 0 && value <= (key === 'count' ? 1000000000 : 600000);
      if (!valid) throw error('INVALID_REQUEST', 'Unknown or unsafe analytics property.');
      safe[key] = value;
    }
    return analyticsCall('analytics.track', {name, properties: safe});
  }

  function semanticTarget(event) {
    let nodes;
    if (typeof event.composedPath === 'function') {
      const path = event.composedPath();
      if (!Array.isArray(path) || path.length > 128) return null;
      nodes = path.filter(node => node && node.nodeType === 1);
    } else {
      nodes = [];
      let node = event.target;
      if (node && node.nodeType !== 1) node = node.parentElement;
      for (let depth = 0; node && depth < 128; depth++, node = node.parentElement) nodes.push(node);
      // A deeper tree cannot prove that an excluded ancestor is absent.
      if (node) return null;
    }
    let candidate = null;
    // Only semantic attributes are read. In particular, DOM text, form values,
    // labels, ids, names and link destinations never enter an observation.
    for (const node of nodes) {
      if (typeof node.getAttribute !== 'function') return null;
      if (node.getAttribute('data-analytics') === 'off') return null;
      const tag = typeof node.tagName === 'string' ? node.tagName.toLowerCase() : '';
      if (tag === 'input' && ['password', 'hidden', 'file'].includes((node.getAttribute('type') || '').toLowerCase())) return null;
      if (candidate) continue;
      const role = node.getAttribute('role');
      const kind = tag === 'button' || role === 'button' ? 'button' : tag === 'a' || role === 'link' ? 'link' :
        ['input', 'textarea'].includes(tag) ? 'input' : tag === 'select' ? 'select' : tag === 'form' ? 'form' : 'other';
      const control = node.getAttribute('data-analytics-id');
      if (kind !== 'other' || control !== null) candidate = {kind, ...(typeof control === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(control) ? {control} : {})};
    }
    return candidate;
  }

  function semanticEvent(event) {
    if (!semanticActive || stopped || event.isTrusted !== true || !['click', 'submit', 'change'].includes(event.type) || semanticPending >= MAX_ANALYTICS_PENDING || pending.size >= MAX_PENDING - MAX_ANALYTICS_PENDING) return;
    let target;
    try { target = semanticTarget(event); } catch { return; }
    if (!target) return;
    const type = event.type;
    const epoch = semanticEpoch;
    semanticPending++;
    ready().then(hello => {
      if (!semanticActive || stopped || epoch !== semanticEpoch || !hello.capabilities.includes('analytics.observe')) return;
      return request('analytics.observe', {type, ...target}, {});
    }).catch(() => {
      // Analytics cannot change the outcome of a click, form submission or
      // business action. Native admission/status owns any dropped counters.
    }).finally(() => { semanticPending--; });
  }

  function startSemanticCapture() {
    if (semanticActive || stopped || !global.document || typeof global.document.addEventListener !== 'function' || typeof global.document.removeEventListener !== 'function') return;
    semanticActive = true;
    for (const name of ['click', 'submit', 'change']) global.document.addEventListener(name, semanticEvent, true);
  }

  function stopSemanticCapture() {
    semanticEpoch++;
    if (!semanticActive) return;
    semanticActive = false;
    for (const name of ['click', 'submit', 'change']) global.document.removeEventListener(name, semanticEvent, true);
  }

  function receive(message) {
    if (stopped) return;
    if (typeof message === 'string') {
      if (encoder.encode(message).byteLength > MAX_WIRE) return;
      try { message = JSON.parse(message); } catch { return; }
    }
    if (!object(message) || message.v !== 1 || message.document !== documentID) return;
    if (typeof message.event === 'string') {
      if (!session || message.session !== session || !object(message.data)) return;
      if (!coreEvents.has(message.event)) {
        const subscription = nativeSubscriptions.get(message.event);
        if (!externalEvents.has(message.event) || !subscription || !subscription.active || !subscription.sent || message.subscription !== subscription.id) return;
      }
      const normalize = eventNormalizers.get(message.event);
      if (normalize) {
        try { message = {...message, data: normalize(message.event, message.data)}; }
        catch { return; }
      }
      const callbacks = listeners.get(message.event);
      if (callbacks) for (const callback of [...callbacks]) {
        try { callback(message.data); }
        catch { if (global.console) global.console.error('Platform event listener failed.'); }
      }
      return;
    }
    if (!identifier(message.id) || typeof message.ok !== 'boolean') return;
    const item = pending.get(message.id);
    if (!item) return;
    if (item.action === 'hello') {
      if (message.ok) {
        if (!identifier(message.session)) return;
        session = message.session;
      }
    } else if (!session || message.session !== session) return;
    if (message.ok) settle(message.id, 'resolve', message.result);
    else {
      if (!object(message.error) || typeof message.error.code !== 'string' || message.error.code.length > 64 || typeof message.error.message !== 'string' || message.error.message.length > 1024) return;
      settle(message.id, 'reject', error(message.error.code, message.error.message));
    }
  }

  function on(event, callback) {
    if (stopped) throw error('UNAVAILABLE', 'Platform SDK has been disposed.');
    if ((!coreEvents.has(event) && !externalEvents.has(event)) || typeof callback !== 'function') throw error('INVALID_REQUEST', 'Unknown platform event or invalid callback.');
    let count = 0;
    for (const callbacks of listeners.values()) count += callbacks.size;
    if (count >= 128) throw error('QUOTA_EXCEEDED', 'Platform event listener limit exceeded.');
    if (!listeners.has(event)) listeners.set(event, new Set());
    const callbacks = listeners.get(event);
    callbacks.add(callback);
    if (externalEvents.has(event) && !nativeSubscriptions.has(event)) installSubscription(event);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      callbacks.delete(callback);
      if (!callbacks.size) {
        listeners.delete(event);
        const subscription = nativeSubscriptions.get(event);
        if (subscription) retireSubscription(event, subscription);
      }
    };
  }

  function installSubscription(event) {
    if (nativeSubscriptions.size >= 32) throw error('QUOTA_EXCEEDED', 'Native subscription limit exceeded.');
    const entry = {id: `sub-${nonce()}`, active: true, sent: false, installed: false};
    nativeSubscriptions.set(event, entry);
    entry.promise = ready().then(hello => {
      if (!entry.active || stopped || nativeSubscriptions.get(event) !== entry) return;
      if (!hello.capabilities.includes('events.subscribe') || !hello.capabilities.includes('events.unsubscribe')) return;
      entry.sent = true;
      entry.session = session;
      entry.document = documentID;
      return request('events.subscribe', {event, subscription: entry.id}, {}).then(() => { entry.installed = true; });
    });
    entry.promise.catch(() => { /* Availability is discoverable through ready().capabilities. */ });
  }

  function retireSubscription(event, entry) {
    entry.active = false;
    if (nativeSubscriptions.get(event) === entry) nativeSubscriptions.delete(event);
    // Wait for admission to settle. An old removal can never remove a newer
    // subscription for the same event because the native ID is distinct.
    entry.promise.then(() => {
      if (entry.sent && !stopped && session === entry.session && documentID === entry.document) return request('events.unsubscribe', {subscription: entry.id}, {});
    }, () => {
      // The host may have admitted before an acknowledgment was lost.
      if (entry.sent && !stopped && session === entry.session && documentID === entry.document) return request('events.unsubscribe', {subscription: entry.id}, {});
    }).catch(() => {});
  }

  function invalidate(message) {
    for (const [event, entry] of nativeSubscriptions) retireSubscription(event, entry);
    for (const id of [...pending.keys()]) {
      cancelRemote(id);
      settle(id, 'reject', error('CANCELLED', message));
    }
    session = null;
    readyPromise = null;
  }

  function pagehide() { stopSemanticCapture(); invalidate('Document is no longer active.'); }
  function pageshow(event) {
    if (event.persisted && !stopped) {
      documentID = nonce();
      sequence = 0;
      analyticsSequence = 0;
      session = null;
      readyPromise = null;
      for (const event of listeners.keys()) if (externalEvents.has(event)) installSubscription(event);
      startSemanticCapture();
    }
  }
  function dispose() {
    if (stopped) return;
    stopSemanticCapture();
    invalidate('Platform SDK was disposed.');
    stopped = true;
    listeners.clear();
    global.removeEventListener('pagehide', pagehide);
    global.removeEventListener('pageshow', pageshow);
  }

  const helper = action => (args = {}, options = {}) => call(action, args, options);
  const platform = {
    protocolVersion: 1,
    PlatformError,
    ready, call, on, dispose,
    analytics: Object.freeze({track: analyticsTrack, status: () => analyticsCall('analytics.status'), flush: () => analyticsCall('analytics.flush', {}, {timeoutMs: 30000})}),
    navigation: Object.freeze({back: helper('navigation.back'), present: helper('navigation.present'), dismiss: helper('navigation.dismiss'), update: helper('navigation.update'), visit: helper('navigation.visit')}),
    chrome: Object.freeze({state: helper('chrome.state'), update: helper('chrome.update'), selectTab: helper('chrome.selectTab')}),
    notifications: Object.freeze({status: helper('notifications.status'), requestPermission: helper('notifications.requestPermission'), register: helper('notifications.register')}),
    links: Object.freeze({getInitial: helper('links.getInitial')}),
    share: Object.freeze({present: helper('share.present')}),
    biometrics: Object.freeze({status: helper('biometrics.status'), authenticate: helper('biometrics.authenticate')}),
    haptics: Object.freeze({impact: helper('haptics.impact')}),
    camera: Object.freeze({capture: helper('camera.capture')}),
    files: Object.freeze({previewURL: (file, options) => call('files.previewURL', {file}, options), remove: (file, options) => call('files.remove', {file}, options)}),
    toolbar: Object.freeze({set: helper('toolbar.set'), clear: helper('toolbar.clear')}),
  };
  for (let index = 0; index < pluginDescriptors.length; index++) {
    const descriptor = pluginDescriptors[index];
    if (Object.prototype.hasOwnProperty.call(platform, descriptor.id)) throw error('INVALID_REQUEST', 'Plug-in namespace collides with the platform API.');
    const actions = new Set(descriptor.actions.map(action => action.name));
    const events = new Set(descriptor.events);
    const plugin = pluginFactories[index](Object.freeze({
      PlatformError, ready,
      call(action, args = {}, options = {}) {
        if (!actions.has(action)) return Promise.reject(error('UNSUPPORTED', 'Action is not declared by this plug-in.'));
        return call(action, args, options);
      },
      on(event, callback) {
        if (!events.has(event)) throw error('UNSUPPORTED', 'Event is not declared by this plug-in.');
        return on(event, callback);
      },
    }));
    if (!object(plugin) || !object(plugin.namespace) || (plugin.normalizeEvent !== undefined && typeof plugin.normalizeEvent !== 'function')) throw error('INVALID_REQUEST', 'Invalid plug-in installer result.');
    platform[descriptor.id] = Object.freeze(plugin.namespace);
    if (plugin.normalizeEvent) for (const event of events) eventNormalizers.set(event, plugin.normalizeEvent);
  }
  Object.freeze(platform);
  Object.defineProperty(global, '__spaReceive', {value: receive, configurable: false, writable: false});
  Object.defineProperty(global, 'platform', {value: platform, configurable: false, writable: false});
  global.addEventListener('pagehide', pagehide);
  global.addEventListener('pageshow', pageshow);
  startSemanticCapture();
})(window);
