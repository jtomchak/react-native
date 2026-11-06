import {createHash} from 'node:crypto';

export const CATEGORIES = ['lifecycle', 'navigation', 'bridge', 'interaction', 'custom'];
export const PROPERTY_KEYS = ['screen', 'action', 'control', 'tab', 'code', 'kind', 'outcome', 'durationMs', 'count', 'state', 'presentation'];
const token = /^[A-Za-z0-9_.:-]{1,64}$/;
const name = /^[a-z][a-z0-9_.]{0,63}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const choices = {
  screen: ['overview', 'compose', 'library', 'hosted', 'unknown'],
  kind: ['button', 'link', 'input', 'select', 'form', 'other'],
  outcome: ['ok', 'error', 'cancelled', 'unavailable'],
  state: ['started', 'foreground', 'background', 'selected', 'committed', 'failed', 'disposed'],
  presentation: ['push', 'replace', 'modal', 'pop', 'web'],
};
function fail(message) { throw new Error(message); }
export function object(value, keys, required = keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail('Invalid analytics object');
}
export function integer(value, minimum, maximum) { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail('Invalid analytics integer'); return value; }
export function semanticToken(value) { if (typeof value !== 'string' || !token.test(value)) fail('Invalid semantic token'); return value; }
function array(value, max, validate) {
  if (!Array.isArray(value) || value.length > max || new Set(value).size !== value.length) fail('Invalid analytics list');
  value.forEach(validate); return value;
}
export function properties(value) {
  object(value, PROPERTY_KEYS, []);
  for (const [key, item] of Object.entries(value)) {
    if (choices[key]) { if (!choices[key].includes(item)) fail('Invalid semantic property'); }
    else if (key === 'durationMs' || key === 'count') integer(item, 0, key === 'durationMs' ? 600000 : 1000000000);
    else semanticToken(item);
  }
  return value;
}
export function event(value, now = Date.now()) {
  object(value, ['schemaVersion', 'id', 'installId', 'sessionId', 'timeMs', 'platform', 'source', 'category', 'name', 'properties']);
  if (value.schemaVersion !== 1 || !['id', 'installId', 'sessionId'].every(key => typeof value[key] === 'string' && uuid.test(value[key]))) fail('Invalid event identity');
  integer(value.timeMs, 0, Math.min(Number.MAX_SAFE_INTEGER, now + 300000));
  if (!['ios', 'android'].includes(value.platform) || !['native', 'web'].includes(value.source) || !CATEGORIES.includes(value.category) || typeof value.name !== 'string' || !name.test(value.name)) fail('Invalid event type');
  if (value.source === 'web' && !['interaction', 'custom'].includes(value.category)) fail('Web cannot assert native event provenance');
  if (value.category === 'custom' && !value.name.startsWith('custom.')) fail('Invalid custom event name');
  properties(value.properties);
  if (Buffer.byteLength(JSON.stringify(value)) > 4096) fail('Analytics event too large');
  return value;
}
export function policy(value, {now = Date.now(), destinations = ['recording']} = {}) {
  object(value, ['schemaVersion', 'revision', 'expiresAtMs', 'enabled', 'categories', 'names', 'properties', 'sampleBasisPoints', 'lookbackSeconds', 'destinations']);
  if (value.schemaVersion !== 1 || typeof value.enabled !== 'boolean') fail('Invalid analytics policy');
  integer(value.revision, 1, 2147483647); integer(value.expiresAtMs, now + 1, now + 86400000);
  array(value.categories, 5, category => { if (!CATEGORIES.includes(category)) fail('Unknown analytics category'); });
  array(value.names, 32, item => { if (item !== '*' && (typeof item !== 'string' || !name.test(item))) fail('Invalid policy event name'); });
  properties(value.properties); if (Object.keys(value.properties).length > 8) fail('Too many property selectors');
  integer(value.sampleBasisPoints, 0, 10000); integer(value.lookbackSeconds, 0, 604800);
  array(value.destinations, 8, id => { semanticToken(id); if (!destinations.includes(id)) fail('Destination not configured'); });
  return value;
}
export function policySelectors(value) {
  const {expiresAtMs, ...selectors} = value;
  return JSON.stringify(selectors, Object.keys(selectors).sort().concat(PROPERTY_KEYS));
}
export function sampleBucket(id) {
  let hash = 2166136261;
  for (const byte of Buffer.from(id, 'utf8')) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  return hash % 10000;
}
export function matches(value, selection, now = Date.now()) {
  return selection.enabled && selection.expiresAtMs > now && value.timeMs >= now - selection.lookbackSeconds * 1000 && value.timeMs <= now &&
    selection.categories.includes(value.category) && (selection.names.includes('*') || selection.names.includes(value.name)) &&
    Object.entries(selection.properties).every(([key, expected]) => Object.hasOwn(value.properties, key) && value.properties[key] === expected) &&
    sampleBucket(value.id) < selection.sampleBasisPoints;
}
export function batch(value, {now = Date.now(), destinations = ['recording']} = {}) {
  object(value, ['schemaVersion', 'destination', 'policyRevision', 'events']);
  if (value.schemaVersion !== 1 || !destinations.includes(value.destination)) fail('Unconfigured analytics destination');
  semanticToken(value.destination); integer(value.policyRevision, 1, 2147483647);
  if (!Array.isArray(value.events) || value.events.length < 1 || value.events.length > 100 || new Set(value.events.map(item => item?.id)).size !== value.events.length) fail('Invalid analytics event batch');
  value.events.forEach(item => event(item, now));
  if (Buffer.byteLength(JSON.stringify(value)) > 262144) fail('Analytics batch too large');
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function digest(value) { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
