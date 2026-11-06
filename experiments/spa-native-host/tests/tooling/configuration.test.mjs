import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {hostedOrigin, validateConfiguration, applicationPath} from '../../tooling/configuration.mjs';
import {loadSelectedPlugins} from '../../tooling/plugins.mjs';

const defaults = JSON.parse(await readFile(new URL('../../configuration/host-config.json', import.meta.url)));
const fresh = () => structuredClone(defaults);

test('default packaged configuration and bounded native/adaptive option compose independently', () => {
  assert.equal(validateConfiguration(fresh()).content.mode, 'packaged');
  const c = fresh(); c.navigation.mode = 'native'; c.chrome.mode = 'adaptive';
  assert.equal(validateConfiguration(c).chrome.mode, 'adaptive');
});
test('hosted origin is exact HTTPS; Debug HTTP only for explicit loopback', () => {
  assert.equal(hostedOrigin('https://example.com:443/'), 'https://example.com');
  assert.equal(hostedOrigin('http://127.0.0.1:18797', {allowDebugLoopback: true}), 'http://127.0.0.1:18797');
  for (const origin of ['http://example.com', 'http://127.0.0.1:18797', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com?x=1', 'https://example.com#', 'javascript:alert(1)', 'https://example.com.']) assert.throws(() => hostedOrigin(origin));
  assert.throws(() => hostedOrigin('http://192.168.1.20:18797', {allowDebugLoopback: true}));
});
test('hosted configuration requires origin and packaged cannot restore a server-only route', () => {
  const c = fresh(); c.content.mode = 'hosted'; assert.throws(() => validateConfiguration(c));
  c.content.origin = 'https://example.com'; c.content.initialPath = '/hosted/?id=1';
  assert.equal(validateConfiguration(c).content.initialPath, '/hosted/?id=1');
  c.content.mode = 'packaged'; assert.throws(() => validateConfiguration(c));
});
test('native grants reject arbitrary tab destinations, excessive surfaces and unknown keys', () => {
  const cases = [c => {c.chrome.tabs[0].path = 'https://evil.example';}, c => {c.chrome.tabs.push({...c.chrome.tabs[0]});}, c => {c.navigation.maxLiveSurfaces = 999;}, c => {c.navigation.maxDepthPerTab = 5;}, c => {c.content.allowAnyOrigin = true;}];
  for (const mutate of cases) {const c = fresh(); mutate(c); assert.throws(() => validateConfiguration(c));}
});
test('sender private credentials cannot be accepted as bundled Firebase client configuration', () => {
  const c = fresh(); c.notifications.firebase = {projectId: 'demo', applicationId: 'demo-app', apiKey: 'client-key', senderId: '123'};
  assert.equal(validateConfiguration(c).notifications.firebase.projectId, 'demo');
  c.notifications.firebase.private_key = 'never bundle a provider key'; assert.throws(() => validateConfiguration(c));
});
test('hosted route namespace supports dynamic server paths without permitting path or origin escape', () => {
  assert.equal(applicationPath('/hosted/item/42/?sort=new', {hosted: true}), true);
  assert.equal(applicationPath('/hosted/item/42/'), false);
  for (const input of ['//evil.example/hosted/', '/hosted/../compose/', '/hosted/%2e%2e/compose/', '/hosted/%2f%2fevil', '/hosted/item%2f42/', '/hosted/%252fescape/', '/hosted/%00/', '/hosted/a#fragment', '/hosted/\\evil', '/elsewhere/']) assert.equal(applicationPath(input, {hosted: true}), false, input);
});

test('analytics defaults are native-owned local capture without an upload origin', () => {
  const c = fresh(); delete c.analytics;
  assert.equal(validateConfiguration(c).analytics.origin, null);
  assert.deepEqual(c.analytics.destinations, ['recording']);
  for (const change of [a => {a.origin = 'http://127.0.0.1:18797';}, a => {a.destinations = ['recording', 'recording'];}, a => {a.maxEvents = 10001;}, a => {a.maxBytes = 8388609;}, a => {a.retentionSeconds = 604801;}, a => {a.apiSecret = 'must not bundle';}]) {
    const config = fresh(); change(config.analytics); assert.throws(() => validateConfiguration(config));
  }
});

test('public plug-in options come only from the selected declaration and validators', () => {
  const [auth] = loadSelectedPlugins();
  assert.equal(validateConfiguration(fresh()).plugins.auth.enabled, false);
  assert.deepEqual(validateConfiguration(fresh(), {plugins: []}).plugins, {});
  const options = {enabled: true, origin: 'https://app.example.com', providers: ['enterprise_oidc'], rpId: 'app.example.com'};
  const plugins = [{...auth, configuration: options}];
  assert.equal(validateConfiguration(fresh(), {plugins}).plugins.auth.providers[0], 'enterprise_oidc');
  for (const auth of [
    {...options, origin: 'http://app.example.com'},
    {...options, rpId: 'other.example.com'},
    {...options, providers: ['x', 'x']},
    {...options, clientSecret: 'never-bundle-this'},
  ]) assert.throws(() => validateConfiguration(fresh(), {plugins: [{...plugins[0], configuration: auth}]}));
  assert.throws(() => validateConfiguration({...fresh(), content: {mode: 'hosted', origin: 'https://other.example.com', initialPath: '/'}}, {plugins}));
  assert.throws(() => validateConfiguration({...fresh(), plugins: {auth: options}}));
});
