import {event} from './index.mjs';

// Pure request mappings: credentials come from the trusted server/host adapter
// owner. These functions never make a network request or claim vendor delivery.
function nonempty(value) { if (typeof value !== 'string' || !value || value.length > 1024) throw new Error('Provider configuration is required'); return value; }
function origin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Provider requires an exact HTTPS origin');
  return url.origin;
}
function events(values, now) {
  if (!Array.isArray(values) || !values.length || values.length > 100) throw new Error('Invalid provider batch');
  values.forEach(value => event(value, now));
}
export function posthogRequest(values, {projectToken, endpoint = 'https://us.i.posthog.com', now = Date.now()} = {}) {
  events(values, now); nonempty(projectToken);
  return {method: 'POST', url: origin(endpoint) + '/batch/', headers: {'Content-Type': 'application/json'}, body: {
    api_key: projectToken,
    batch: values.map(value => ({event: value.name, uuid: value.id, timestamp: new Date(value.timeMs).toISOString(), properties: {...value.properties, distinct_id: value.installId, $process_person_profile: false, $ip: null, native_session_id: value.sessionId, native_platform: value.platform}})),
  }};
}
export function mixpanelRequest(values, {projectId, username, password, endpoint = 'https://api.mixpanel.com', now = Date.now()} = {}) {
  events(values, now); nonempty(projectId); nonempty(username); nonempty(password);
  return {method: 'POST', url: origin(endpoint) + '/import?strict=1&project_id=' + encodeURIComponent(projectId), headers: {'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(username + ':' + password).toString('base64')}, body: values.map(value => ({event: value.name, properties: {...value.properties, distinct_id: value.installId, $insert_id: value.id, time: value.timeMs, native_session_id: value.sessionId, native_platform: value.platform}}))};
}
export function ga4Requests(values, {apiSecret, firebaseAppId, appInstanceId, now = Date.now()} = {}) {
  events(values, now); nonempty(apiSecret); nonempty(firebaseAppId);
  if (typeof appInstanceId !== 'function') throw new Error('Firebase app stream requires an actual SDK app-instance identity resolver');
  // Keep original occurrence times and refuse events beyond the provider's72h
  // backdate window. Never substitute our UUID for Firebase's SDK instance ID.
  return values.map(value => {
    if (value.timeMs < now - 72 * 3600000) throw new Error('Event exceeds GA4 backdate window');
    const identity = appInstanceId(value);
    if (typeof identity !== 'string' || !/^[a-f0-9]{32}$/.test(identity)) throw new Error('Actual Firebase app-instance identity is unavailable');
    const mappedName = value.name.replace(/[^A-Za-z0-9_]/g, '_');
    if (mappedName.length > 40 || !/^[A-Za-z]/.test(mappedName) || /^(firebase_|google_|ga_)/.test(mappedName)) throw new Error('Event cannot be represented by GA4');
    return {method: 'POST', url: 'https://www.google-analytics.com/mp/collect?firebase_app_id=' + encodeURIComponent(firebaseAppId) + '&api_secret=' + encodeURIComponent(apiSecret), headers: {'Content-Type': 'application/json'}, body: {app_instance_id: identity, timestamp_micros: value.timeMs * 1000, validation_behavior: 'ENFORCE_RECOMMENDATIONS', events: [{name: mappedName, params: {...value.properties, native_event_id: value.id, native_session_id: value.sessionId}}]}};
  });
}

export class AnalyticsAdapters {
  #adapters = new Map();
  register(id, adapter) {
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(id) || this.#adapters.has(id) || typeof adapter?.deliver !== 'function') throw new Error('Invalid or duplicate analytics adapter');
    this.#adapters.set(id, adapter);
  }
  async deliver(id, values) {
    const adapter = this.#adapters.get(id);
    if (!adapter) throw new Error('Analytics adapter is not configured');
    events(values, Date.now());
    const result = await adapter.deliver(values);
    // A destination implements its own transport/retry/credential integration.
    // No assumption that HTTP2xx means a provider ingested all records.
    if (!result || !['submitted', 'accepted'].includes(result.status) || !Array.isArray(result.accepted) || new Set(result.accepted).size !== result.accepted.length || result.accepted.some(item => !values.some(value => value.id === item))) throw new Error('Invalid adapter receipt');
    return {status: result.status, accepted: [...result.accepted]};
  }
}
