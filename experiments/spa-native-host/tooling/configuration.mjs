import {readFile} from 'node:fs/promises';
import {loadSelectedPlugins, publicPluginConfiguration} from './plugins.mjs';

function object(value, name, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error(`Invalid ${name} configuration`);
}
function text(value, name, maximum = 128) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > maximum || /[\u0000-\u001f]/u.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}
function choice(value, allowed, name) {
  if (!allowed.includes(value)) throw new Error(`Invalid ${name}`);
  return value;
}

export function hostedOrigin(value, {allowDebugLoopback = false} = {}) {
  text(value, 'hosted origin', 2048);
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid hosted origin'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(allowDebugLoopback && loopback && url.protocol === 'http:')) ||
      url.username || url.password || url.pathname !== '/' || value.includes('?') || value.includes('#') || url.hostname.endsWith('.')) throw new Error('Hosted origin must be an exact HTTPS origin without credentials, path, query or fragment');
  return url.origin;
}

export function applicationPath(value, {hosted = false} = {}) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || Buffer.byteLength(value) > 2048 || /[\\#\u0000-\u001f]/u.test(value)) return false;
  let pathname;
  const rawPath = value.split('?')[0];
  if (/%(?:2f|5c|25)/iu.test(rawPath)) return false;
  try { pathname = decodeURIComponent(rawPath); } catch { return false; }
  if (/[\\\u0000-\u001f]/u.test(pathname) || pathname.includes('//') || pathname.split('/').some(segment => segment === '.' || segment === '..')) return false;
  return ['/', '/compose/', '/library/'].includes(pathname) || (hosted && pathname.startsWith('/hosted/'));
}

export function validateConfiguration(config, {plugins = loadSelectedPlugins()} = {}) {
  object(config, 'host', ['schemaVersion', 'content', 'navigation', 'chrome', 'notifications', 'analytics', 'plugins']);
  if (config.schemaVersion !== 1) throw new Error('Unsupported host configuration version');
  object(config.content, 'content', ['mode', 'origin', 'initialPath']);
  choice(config.content.mode, ['packaged', 'hosted'], 'content mode');
  if (config.content.origin !== null) config.content.origin = hostedOrigin(config.content.origin);
  if (config.content.mode === 'hosted' && !config.content.origin) throw new Error('Hosted mode requires a configured HTTPS origin');
  const initial = text(config.content.initialPath, 'initial path', 2048);
  if (!applicationPath(initial, {hosted: config.content.mode === 'hosted'})) throw new Error('Invalid initial application route');
  object(config.navigation, 'navigation', ['mode', 'maxLiveSurfaces', 'maxDepthPerTab']);
  choice(config.navigation.mode, ['web', 'native'], 'navigation mode');
  if (!Number.isInteger(config.navigation.maxLiveSurfaces) || config.navigation.maxLiveSurfaces < 3 || config.navigation.maxLiveSurfaces > 8 ||
      !Number.isInteger(config.navigation.maxDepthPerTab) || config.navigation.maxDepthPerTab < 1 || config.navigation.maxDepthPerTab > 4) throw new Error('Invalid native surface limits');
  object(config.chrome, 'chrome', ['mode', 'largeTitles', 'backGestures', 'tabs']);
  choice(config.chrome.mode, ['standard', 'tabs', 'adaptive'], 'chrome mode');
  if (typeof config.chrome.largeTitles !== 'boolean' || typeof config.chrome.backGestures !== 'boolean' || !Array.isArray(config.chrome.tabs) || config.chrome.tabs.length !== 3) throw new Error('Invalid native chrome options');
  const ids = new Set();
  const destinations = {overview: ['/', 'house'], compose: ['/compose/', 'square.and.pencil'], library: ['/library/', 'photo']};
  for (const tab of config.chrome.tabs) {
    object(tab, 'tab', ['id', 'title', 'path', 'icon']);
    text(tab.title, 'tab title', 64);
    if (!destinations[tab.id] || ids.has(tab.id) || tab.path !== destinations[tab.id][0] || tab.icon !== destinations[tab.id][1]) throw new Error('Invalid native tab destination');
    ids.add(tab.id);
  }
  object(config.notifications, 'notifications', ['enabled', 'firebase']);
  if (typeof config.notifications.enabled !== 'boolean') throw new Error('Invalid notification enablement');
  if (config.notifications.firebase !== null) {
    object(config.notifications.firebase, 'Firebase client', ['projectId', 'applicationId', 'apiKey', 'senderId']);
    for (const key of ['projectId', 'applicationId', 'apiKey', 'senderId']) text(config.notifications.firebase[key], `Firebase client ${key}`, 256);
  }
  if (config.analytics === undefined) config.analytics = {enabled: true, origin: null, destinations: ['recording'], maxEvents: 10000, maxBytes: 8388608, retentionSeconds: 604800};
  object(config.analytics, 'analytics', ['enabled', 'origin', 'destinations', 'maxEvents', 'maxBytes', 'retentionSeconds']);
  const analytics = config.analytics;
  if (typeof analytics.enabled !== 'boolean') throw new Error('Invalid analytics enablement');
  if (analytics.origin !== null) analytics.origin = hostedOrigin(analytics.origin);
  if (!Array.isArray(analytics.destinations) || analytics.destinations.length < 1 || analytics.destinations.length > 8 || new Set(analytics.destinations).size !== analytics.destinations.length || analytics.destinations.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(id))) throw new Error('Invalid analytics destinations');
  for (const [key, min, max] of [['maxEvents', 1, 10000], ['maxBytes', 4096, 8388608], ['retentionSeconds', 1, 604800]]) {
    if (!Number.isInteger(analytics[key]) || analytics[key] < min || analytics[key] > max) throw new Error('Invalid analytics resource bounds');
  }
  const selected = publicPluginConfiguration(plugins, config);
  if (config.plugins !== undefined) {
    object(config.plugins, 'public plug-ins', Object.keys(selected));
    for (const [id, value] of Object.entries(config.plugins)) if (JSON.stringify(value) !== JSON.stringify(selected[id])) throw new Error('Plug-in options must be changed in configuration/plugins.json');
  }
  config.plugins = selected;
  return config;
}

export async function loadConfiguration(file) {
  const raw = await readFile(file);
  if (raw.length > 16384) throw new Error('Host configuration exceeds 16 KiB');
  return validateConfiguration(JSON.parse(raw.toString('utf8')));
}
