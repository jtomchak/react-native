const pending = new Map();
const subscriptions = new Map();
const deliveries = [];

export function echo(payload, delay = 0) {
  return requestEcho(payload, delay, globalThis.__nhEcho);
}

export function echoErrorForTest(payload, delay = 0) {
  if (!__NH_TEST_HOOKS__ || typeof globalThis.__nhTestEchoError !== 'function') throw new Error('Error injection requires native service test hooks');
  return requestEcho(payload, delay, globalThis.__nhTestEchoError);
}

function requestEcho(payload, delay, nativeRequest) {
  if (typeof payload !== 'string') throw new TypeError('echo payload must be a string');
  return pendingRequest(nativeRequest(payload, delay));
}

function pendingRequest(id, decode = value => value) {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  pending.set(id, {resolve, reject, decode});
  return {id, promise, cancel: () => globalThis.__nhCancel(id)};
}

function decodeAppState(payload) {
  const state = JSON.parse(payload);
  if (state.schemaVersion !== 1 || state.generation !== globalThis.__nhGeneration ||
      !['active', 'inactive', 'background'].includes(state.state) || state.source !== 'native-lifecycle' ||
      !Number.isSafeInteger(state.sequence) || state.sequence < 0 ||
      !Number.isFinite(state.capturedAtMs) || state.capturedAtMs < 0) {
    throw new Error('Invalid native AppState payload');
  }
  return Object.freeze(state);
}

// Captures the actual native state at request time, then settles asynchronously
// through the Rust queue. cancel() retains the core's first-terminal-wins rules.
export function getAppState() {
  return pendingRequest(globalThis.__nhAppStateSnapshot(), decodeAppState);
}

// Subsequent transitions only; request a snapshot explicitly for initial state.
export function subscribeAppState(callback) {
  if (typeof callback !== 'function') throw new TypeError('AppState callback must be a function');
  const id = globalThis.__nhAppStateSubscribe();
  subscriptions.set(id, payload => callback(decodeAppState(payload)));
  return {id, unsubscribe() {
    subscriptions.delete(id);
    return globalThis.__nhUnsubscribe(id);
  }};
}

export function subscribe(callback) {
  const id = globalThis.__nhSubscribe();
  subscriptions.set(id, callback);
  return {
    id,
    publish: payload => globalThis.__nhPublish(id, payload),
    unsubscribe() {
      subscriptions.delete(id);
      return globalThis.__nhUnsubscribe(id);
    },
  };
}

globalThis.__nhServiceEvent = raw => {
  const event = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (event.generation !== globalThis.__nhGeneration) return;
  if (__NH_TEST_HOOKS__) {
    // Keep bounded metadata only: completed payloads belong to the consumer.
    deliveries.push({generation: event.generation, id: event.id, kind: event.kind, status: event.status});
    if (deliveries.length > 128) deliveries.shift();
  }
  if (event.kind === 'subscription') {
    subscriptions.get(event.id)?.(event.payload);
    return;
  }
  const request = pending.get(event.id);
  if (!request) return;
  pending.delete(event.id);
  if (event.status === 'success') {
    try { request.resolve(request.decode(event.payload)); }
    catch (error) { request.reject(error); }
  }
  else {
    const error = new Error(event.status === 'cancelled' ? 'Request cancelled' : event.payload);
    error.code = event.status === 'cancelled' ? 'CANCELLED' : 'NATIVE_ERROR';
    request.reject(error);
  }
};

export function serviceStatus() { return {pending: pending.size, subscriptions: subscriptions.size, deliveries: [...deliveries]}; }
