import {assembleSDK} from '../../tooling/plugins.mjs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

const source = await assembleSDK();
const tick = () => new Promise(resolve => setImmediate(resolve));

function host(t, options = {}) {
  const posted = [];
  const listeners = new Map();
  const context = vm.createContext({TextEncoder, Uint8Array, crypto: webcrypto, setTimeout, clearTimeout, console});
  context.window = context;
  if (options.document) context.document = options.document;
  context.addEventListener = (name, fn) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); };
  context.removeEventListener = (name, fn) => listeners.get(name)?.delete(fn);
  const respond = (request, result, override = {}) => context.__spaReceive({v: 1, id: request.id, document: request.document, session: 'native-session', ok: true, result, ...override});
  if (!options.noTransport) context.__SPA_TRANSPORT__ = {
    postMessage(json) {
      const request = JSON.parse(json);
      posted.push(request);
      if (request.action === 'hello' && !options.deferHello) respond(request, options.hello || {platform: 'ios', capabilities: ['storage.get', 'storage.set', 'storage.remove', 'haptics.impact', 'camera.capture']});
      else options.onPost?.(request, respond);
    },
  };
  vm.runInContext(options.source || source, context, {filename: 'platform-sdk.js'});
  t.after(() => context.platform.dispose());
  return {api: context.platform, context, posted, respond, listeners, dispatch(name, event = {}) { for (const fn of listeners.get(name) || []) fn(event); }};
}

test('hello precedes service dispatch and synchronous native responses work', async t => {
  const fixture = host(t, {onPost: (request, respond) => respond(request, request.action === 'storage.get' ? 'saved draft' : null)});
  assert.equal(await fixture.api.storage.get('draft'), 'saved draft');
  assert.equal(fixture.posted[0].action, 'hello');
  assert.equal(fixture.posted[0].session, null);
  assert.equal(fixture.posted[1].session, 'native-session');
  assert.deepEqual(fixture.posted[1].args, {key: 'draft'});
  const hello = await fixture.api.ready();
  assert.equal(hello.platform, 'ios');
  assert.equal(Object.isFrozen(hello.capabilities), true);
});

test('ordinary browser reports UNAVAILABLE without simulating native services', async t => {
  const {api} = host(t, {noTransport: true});
  await assert.rejects(api.haptics.impact({style: 'light'}), {code: 'UNAVAILABLE'});
});

test('stale identity and duplicate terminal responses cannot resolve another operation', async t => {
  const fixture = host(t);
  await fixture.api.ready();
  const operation = fixture.api.storage.get('draft');
  await tick();
  const request = fixture.posted.at(-1);
  let settled = false;
  operation.then(() => { settled = true; });
  fixture.respond(request, 'wrong document', {document: 'replacement'});
  fixture.respond(request, 'wrong session', {session: 'replacement'});
  fixture.respond(request, 'wrong version', {v: 2});
  await tick();
  assert.equal(settled, false);
  fixture.respond(request, 'right value');
  fixture.respond(request, 'duplicate');
  assert.equal(await operation, 'right value');
});

test('abort settles once, sends cancellation, and ignores late camera completion', async t => {
  const fixture = host(t);
  const controller = new AbortController();
  const operation = fixture.api.camera.capture({}, {signal: controller.signal});
  const rejected = assert.rejects(operation, {code: 'CANCELLED'});
  await tick();
  const request = fixture.posted.at(-1);
  assert.equal(request.action, 'camera.capture');
  controller.abort();
  await rejected;
  assert.equal(fixture.posted.at(-1).action, 'cancel');
  assert.equal(fixture.posted.at(-1).args.requestId, request.id);
  fixture.respond(request, {file: 'late-file', mimeType: 'image/jpeg'});
});

test('abort before readiness promptly rejects without dispatching a service', async t => {
  const fixture = host(t, {deferHello: true});
  const controller = new AbortController();
  const operation = fixture.api.storage.get('draft', {signal: controller.signal});
  const rejected = assert.rejects(operation, {code: 'CANCELLED'});
  controller.abort();
  await rejected;
  assert.equal(fixture.posted.length, 1);
  assert.equal(fixture.posted[0].action, 'hello');
  fixture.respond(fixture.posted[0], {platform: 'android', capabilities: ['storage.get']});
  await tick();
  assert.equal(fixture.posted.length, 1);
});

test('timeout is terminal and does not replay a native operation', async t => {
  const fixture = host(t);
  await assert.rejects(fixture.api.haptics.impact({style: 'light'}, {timeoutMs: 5}), {code: 'TIMEOUT'});
  assert.deepEqual(fixture.posted.map(item => item.action), ['hello', 'haptics.impact', 'cancel']);
});

test('malformed and oversize requests never cross the transport', async t => {
  const fixture = host(t);
  await fixture.api.ready();
  await assert.rejects(fixture.api.call('storage.set', {value: 'x'.repeat(128 * 1024)}), {code: 'QUOTA_EXCEEDED'});
  const cycle = {}; cycle.self = cycle;
  await assert.rejects(fixture.api.call('storage.set', cycle), {code: 'INVALID_REQUEST'});
  await assert.rejects(fixture.api.call('hello'), {code: 'INVALID_REQUEST'});
  await assert.rejects(fixture.api.call('storage.get', {} , {timeoutMs: Infinity}), {code: 'INVALID_REQUEST'});
  assert.equal(fixture.posted.length, 1);
});

test('native typed failures propagate without pretending success', async t => {
  const fixture = host(t, {onPost(request, respond) { respond(request, undefined, {ok: false, error: {code: 'QUOTA_EXCEEDED', message: 'Storage is full.'}}); }});
  await assert.rejects(fixture.api.storage.set('draft', 'value'), {name: 'PlatformError', code: 'QUOTA_EXCEEDED', message: 'Storage is full.'});
});

test('pending capacity is bounded and disposing rejects all live requests', async t => {
  const fixture = host(t);
  await fixture.api.ready();
  const operations = Array.from({length: 64}, () => fixture.api.storage.get('draft'));
  const cancellations = operations.map(operation => assert.rejects(operation, {code: 'CANCELLED'}));
  await tick();
  await assert.rejects(fixture.api.storage.get('overflow'), {code: 'QUOTA_EXCEEDED'});
  fixture.api.dispose();
  await Promise.all(cancellations);
  await assert.rejects(fixture.api.ready(), {code: 'UNAVAILABLE'});
  assert.equal(fixture.listeners.get('pagehide').size, 0);
  assert.equal(fixture.listeners.get('pageshow').size, 0);
});

test('events require current document/session and disposing listener releases callback', async t => {
  const fixture = host(t);
  await fixture.api.ready();
  const hello = fixture.posted[0];
  const received = [];
  const stop = fixture.api.on('toolbar.action', value => received.push(value.id));
  const event = {v: 1, document: hello.document, session: 'native-session', event: 'toolbar.action', data: {id: 'save'}};
  fixture.context.__spaReceive({...event, session: 'stale'});
  fixture.context.__spaReceive(event);
  stop();
  fixture.context.__spaReceive(event);
  assert.deepEqual(received, ['save']);
});

test('SDK reinjection is idempotent and pagehide invalidates outstanding requests', async t => {
  const fixture = host(t);
  vm.runInContext(source, fixture.context);
  assert.equal(fixture.context.platform, fixture.api);
  assert.equal(fixture.listeners.get('pagehide').size, 1);
  const operation = fixture.api.storage.get('draft');
  const rejected = assert.rejects(operation, {code: 'CANCELLED'});
  await tick();
  fixture.dispatch('pagehide');
  await rejected;
});

test('invalid hello capabilities reject the handshake', async t => {
  const fixture = host(t, {deferHello: true});
  const operation = fixture.api.ready();
  fixture.respond(fixture.posted[0], {platform: 'browser', capabilities: []});
  await assert.rejects(operation, {code: 'INVALID_REQUEST'});
});

const extendedHello = {
  platform: 'ios',
  capabilities: ['events.subscribe', 'events.unsubscribe', 'navigation.visit', 'chrome.state', 'share.present', 'notifications.status', 'biometrics.status'],
  host: {apiVersion: 2, contentMode: 'hosted', navigationMode: 'native', chromeMode: 'tabs', surfaceId: 'surface-1', activeTab: 'overview'},
};

test('additive hello metadata is immutable and malformed ownership metadata is rejected', async t => {
  const fixture = host(t, {hello: extendedHello});
  const hello = await fixture.api.ready();
  assert.equal(hello.host.navigationMode, 'native');
  assert.equal(hello.host.contentMode, 'hosted');
  assert.equal(Object.isFrozen(hello.host), true);
  const invalid = host(t, {hello: {...extendedHello, host: {...extendedHello.host, contentMode: 'untrusted'}}});
  await assert.rejects(invalid.api.ready(), {code: 'INVALID_REQUEST'});
});

test('removing an external listener before hello completes never admits a subscription', async t => {
  const fixture = host(t, {deferHello: true});
  const stop = fixture.api.on('notifications.received', () => {});
  stop();
  fixture.respond(fixture.posted[0], extendedHello);
  await tick();
  assert.deepEqual(fixture.posted.map(request => request.action), ['hello']);
});

test('subscription replacement rejects old events and late removal cannot unsubscribe the new owner', async t => {
  const admissions = [];
  const fixture = host(t, {hello: extendedHello, onPost(request, respond) {
    if (request.action === 'events.subscribe') admissions.push(request);
    else respond(request, null);
  }});
  const received = [];
  const oldStop = fixture.api.on('notifications.opened', value => received.push(`old:${value.path}`));
  await tick();
  assert.equal(admissions.length, 1);
  const first = admissions[0];
  oldStop();
  const stop = fixture.api.on('notifications.opened', value => received.push(`new:${value.path}`));
  await tick();
  assert.equal(admissions.length, 2);
  const second = admissions[1];
  assert.notEqual(first.args.subscription, second.args.subscription);
  fixture.respond(first, null);
  await tick();
  const removals = fixture.posted.filter(request => request.action === 'events.unsubscribe');
  assert.equal(removals.length, 1);
  assert.equal(removals[0].args.subscription, first.args.subscription);
  const base = {v: 1, document: second.document, session: 'native-session', event: 'notifications.opened', data: {path: '/compose/'}};
  fixture.context.__spaReceive({...base, subscription: first.args.subscription});
  fixture.context.__spaReceive(base);
  fixture.respond(second, null);
  fixture.context.__spaReceive({...base, subscription: second.args.subscription});
  assert.deepEqual(received, ['new:/compose/']);
  stop();
});

test('document retirement cannot send an old unsubscribe into a replacement document', async t => {
  const admissions = [];
  const fixture = host(t, {hello: extendedHello, onPost(request, respond) {
    if (request.action === 'events.subscribe') admissions.push(request);
    else respond(request, null);
  }});
  fixture.api.on('links.opened', () => {});
  await tick();
  const old = admissions[0];
  fixture.dispatch('pagehide');
  fixture.dispatch('pageshow', {persisted: true});
  await tick();
  fixture.respond(old, null);
  await tick();
  assert.equal(fixture.posted.some(request => request.action === 'events.unsubscribe' && request.document !== old.document && request.args.subscription === old.args.subscription), false);
  fixture.respond(admissions.at(-1), null);
});

test('native visit and service helpers use the same bounded action protocol', async t => {
  const fixture = host(t, {hello: extendedHello, onPost(request, respond) {respond(request, request.args);}});
  assert.equal((await fixture.api.navigation.visit({path: '/compose/', presentation: 'push'})).presentation, 'push');
  await fixture.api.chrome.selectTab({id: 'library'});
  await fixture.api.notifications.status();
  await fixture.api.share.present({text: 'A native share'});
  await fixture.api.biometrics.status();
  assert.deepEqual(fixture.posted.slice(1).map(request => request.action), ['navigation.visit', 'chrome.selectTab', 'notifications.status', 'share.present', 'biometrics.status']);
});

const analyticsHello = {platform: 'ios', capabilities: ['analytics.observe', 'analytics.track', 'analytics.status', 'analytics.flush', 'storage.get']};

function semanticDOM() {
  const handlers = new Map();
  const document = {
    addEventListener(name, handler, capture) {
      assert.equal(capture, true);
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(handler);
    },
    removeEventListener(name, handler, capture) { assert.equal(capture, true); handlers.get(name)?.delete(handler); },
  };
  const element = (tag, attributes = {}, parentElement = null) => {
    const node = {nodeType: 1, tagName: tag.toUpperCase(), parentElement, getAttribute(name) {
      assert.ok(['data-analytics', 'data-analytics-id', 'type', 'role'].includes(name), `Read unsafe attribute ${name}`);
      return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
    }};
    for (const name of ['value', 'textContent', 'innerText', 'id', 'name', 'href', 'ariaLabel']) Object.defineProperty(node, name, {get() { throw new Error(`Read private DOM field ${name}`); }});
    return node;
  };
  return {document, handlers, element, dispatch(type, target, extra = {}) { for (const handler of handlers.get(type) || []) handler({type, target, isTrusted: true, ...extra}); }};
}

test('analytics helpers require capabilities and reject unsafe custom data before transport', async t => {
  const fixture = host(t, {hello: analyticsHello, onPost(request, respond) { respond(request, {accepted: true}); }});
  await fixture.api.analytics.track('custom.draft_saved', {control: 'draft.save', count: 1});
  await fixture.api.analytics.status();
  await fixture.api.analytics.flush();
  assert.deepEqual(fixture.posted.slice(1).map(request => [request.action, request.args]), [
    ['analytics.track', {name: 'custom.draft_saved', properties: {control: 'draft.save', count: 1}}],
    ['analytics.status', {}], ['analytics.flush', {}],
  ]);
  for (const [name, properties] of [['app.started', {}], ['custom.bad', {value: 'private draft'}], ['custom.bad', {screen: '/customer/private'}], ['custom.bad', {control: 'private@example.test'}], ['custom.bad', {count: Infinity}], ['custom.bad', {constructor: 'unsafe'}]]) await assert.rejects(fixture.api.analytics.track(name, properties), {code: 'INVALID_REQUEST'});
  assert.equal(fixture.posted.length, 4);
  const unavailable = host(t);
  await assert.rejects(unavailable.api.analytics.status(), {code: 'UNSUPPORTED'});
  assert.equal(unavailable.posted.length, 1);
});

test('semantic DOM capture emits only explicit control and kind, without reading private fields', async t => {
  const dom = semanticDOM();
  const fixture = host(t, {document: dom.document, hello: analyticsHello, onPost(request, respond) { respond(request, {accepted: true}); }});
  const form = dom.element('form', {'data-analytics-id': 'draft.form'});
  const button = dom.element('button', {'data-analytics-id': 'draft.save'}, form);
  dom.dispatch('click', dom.element('span', {}, button));
  dom.dispatch('change', dom.element('textarea', {'data-analytics-id': 'draft.input'}, form));
  dom.dispatch('submit', form);
  dom.dispatch('click', dom.element('a', {'data-analytics-id': 'unsafe identifier with personal data'}));
  await tick();
  assert.deepEqual(fixture.posted.filter(request => request.action === 'analytics.observe').map(request => request.args), [
    {type: 'click', kind: 'button', control: 'draft.save'},
    {type: 'change', kind: 'input', control: 'draft.input'},
    {type: 'submit', kind: 'form', control: 'draft.form'},
    {type: 'click', kind: 'link'},
  ]);
  assert.equal(fixture.posted.some(request => request.action === 'analytics.track'), false);
});

test('semantic capture excludes sensitive inputs, excluded ancestors, synthetic events and shadow-tree exclusions', async t => {
  const dom = semanticDOM();
  const fixture = host(t, {document: dom.document, hello: analyticsHello, onPost(request, respond) { respond(request, null); }});
  const button = dom.element('button', {'data-analytics-id': 'allowed'});
  for (const type of ['password', 'hidden', 'file']) dom.dispatch('change', dom.element('input', {type, 'data-analytics-id': 'must-not-capture'}));
  dom.dispatch('click', dom.element('button', {}, dom.element('section', {'data-analytics': 'off'})));
  dom.dispatch('click', button, {isTrusted: false});
  dom.dispatch('click', button, {composedPath: () => [button, dom.element('section', {'data-analytics': 'off'})]});
  dom.dispatch('click', button, {composedPath: () => [dom.element('input', {type: 'password'}), button]});
  await tick();
  assert.equal(fixture.posted.length, 0);
  dom.dispatch('click', button);
  await tick();
  assert.equal(fixture.posted.filter(request => request.action === 'analytics.observe').length, 1);
});

test('automatic observations are bounded while waiting for hello and do not consume all business request capacity', async t => {
  const dom = semanticDOM();
  const fixture = host(t, {document: dom.document, deferHello: true, onPost(request, respond) { if (request.action === 'storage.get') respond(request, 'business result'); }});
  const button = dom.element('button');
  for (let index = 0; index < 100; index++) dom.dispatch('click', button);
  assert.equal(fixture.posted.length, 1);
  const business = fixture.api.storage.get('draft');
  fixture.respond(fixture.posted[0], analyticsHello);
  assert.equal(await business, 'business result');
  await tick();
  const observations = fixture.posted.filter(request => request.action === 'analytics.observe');
  assert.equal(observations.length, 8);
  observations.forEach(request => fixture.respond(request, null));
});

test('analytics uses a separate monotonic lane beyond ordinary lifetime capacity and for cancellation', async t => {
  const dom = semanticDOM();
  const fixture = host(t, {document: dom.document, hello: analyticsHello, onPost(request, respond) { respond(request, request.action === 'storage.get' ? 'business result' : null); }});
  const button = dom.element('button');
  for (let index = 0; index < 4100; index++) {
    dom.dispatch('click', button);
    await tick();
  }
  const observations = fixture.posted.filter(request => request.action === 'analytics.observe');
  assert.equal(observations.length, 4100);
  observations.forEach((request, index) => assert.equal(request.id, `${request.document}-a${index + 1}`));
  assert.equal(await fixture.api.storage.get('draft'), 'business result');
  assert.equal(fixture.posted.at(-1).id, `${fixture.posted[0].document}-2`);

  const cancellable = host(t, {hello: analyticsHello});
  const controller = new AbortController();
  const operation = cancellable.api.call('analytics.status', {}, {signal: controller.signal});
  const rejected = assert.rejects(operation, {code: 'CANCELLED'});
  await tick();
  const request = cancellable.posted.at(-1);
  assert.equal(request.id, `${request.document}-a1`);
  controller.abort();
  await rejected;
  assert.equal(cancellable.posted.at(-1).id, `${request.document}-a2`);
  assert.equal(cancellable.posted.at(-1).action, 'cancel');
  assert.equal(cancellable.posted.at(-1).args.requestId, request.id);
});

test('semantic listeners are capability-gated, idempotent and retired across BFCache/disposal', async t => {
  const dom = semanticDOM();
  const fixture = host(t, {document: dom.document, deferHello: true, onPost(request, respond) { if (request.action !== 'hello') respond(request, null); }});
  const button = dom.element('button', {'data-analytics-id': 'draft.save'});
  vm.runInContext(source, fixture.context);
  assert.equal(dom.handlers.get('click').size, 1);
  dom.dispatch('click', button);
  const firstHello = fixture.posted[0];
  fixture.dispatch('pagehide');
  assert.equal(dom.handlers.get('click').size, 0);
  fixture.dispatch('pageshow', {persisted: true});
  assert.equal(dom.handlers.get('click').size, 1);
  fixture.respond(firstHello, analyticsHello);
  dom.dispatch('click', button);
  const replacementHello = fixture.posted.at(-1);
  assert.equal(replacementHello.action, 'hello');
  assert.notEqual(replacementHello.document, firstHello.document);
  fixture.respond(replacementHello, analyticsHello);
  await tick();
  const observations = fixture.posted.filter(request => request.action === 'analytics.observe');
  assert.equal(observations.length, 1);
  assert.equal(observations[0].document, replacementHello.document);
  fixture.api.dispose();
  assert.equal(dom.handlers.get('click').size, 0);
  assert.equal(dom.handlers.get('change').size, 0);
  assert.equal(dom.handlers.get('submit').size, 0);
  dom.dispatch('click', button);
  assert.equal(fixture.posted.filter(request => request.action === 'analytics.observe').length, 1);

  const unsupportedDOM = semanticDOM();
  const unsupported = host(t, {document: unsupportedDOM.document});
  unsupportedDOM.dispatch('click', unsupportedDOM.element('button'));
  await tick();
  assert.deepEqual(unsupported.posted.map(request => request.action), ['hello']);
});

const authHello = {platform: 'ios', capabilities: ['auth.status', 'auth.signIn', 'auth.registerPasskey', 'auth.signOut', 'auth.syncWebSession', 'events.subscribe', 'events.unsubscribe']};
const signedIn = {authenticated: true, user: {id: 'account-1', name: 'Test account'}, expiresAt: 1900000000000};

test('authentication helpers require native capabilities and reject malformed arguments', async t => {
  const unavailable = host(t);
  await assert.rejects(unavailable.api.auth.status(), {code: 'UNSUPPORTED'});
  assert.deepEqual(unavailable.posted.map(request => request.action), ['hello']);
  const fixture = host(t, {hello: authHello});
  for (const args of [{method: 'password'}, {method: 'oauth'}, {method: 'passkey', provider: 'provider'}, {method: 'oauth', provider: '../provider'}, {method: 'oauth', provider: 'provider', token: 'secret'}]) {
    await assert.rejects(fixture.api.auth.signIn(args), {code: 'INVALID_REQUEST'});
  }
  await assert.rejects(fixture.api.auth.status({token: 'secret'}), {code: 'INVALID_REQUEST'});
  assert.equal(fixture.posted.length, 0);
});

test('authentication facade exposes immutable summaries without native credentials', async t => {
  const fixture = host(t, {hello: authHello, onPost(request, respond) {
    const response = request.action === 'auth.registerPasskey' ? {registered: true} : request.action === 'auth.syncWebSession' ? {synchronized: true} : request.action === 'auth.signOut' ? {authenticated: false, revoked: false} : {...signedIn, configured: true, providers: ['test'], passkeys: true};
    respond(request, {...response, accessToken: 'native-secret', refreshToken: 'native-refresh', cookie: 'session-cookie'});
  }});
  const status = await fixture.api.auth.status();
  assert.deepEqual(JSON.parse(JSON.stringify(status)), {...signedIn, configured: true, providers: ['test'], passkeys: true});
  assert.equal(Object.isFrozen(status), true);
  assert.equal(Object.isFrozen(status.user), true);
  assert.equal(Object.isFrozen(status.providers), true);
  assert.equal((await fixture.api.auth.signIn({method: 'oauth', provider: 'test'})).user.id, 'account-1');
  await fixture.api.auth.signIn({method: 'passkey'});
  assert.deepEqual(JSON.parse(JSON.stringify(await fixture.api.auth.registerPasskey())), {registered: true});
  assert.deepEqual(JSON.parse(JSON.stringify(await fixture.api.auth.syncWebSession())), {synchronized: true});
  assert.deepEqual(JSON.parse(JSON.stringify(await fixture.api.auth.signOut())), {authenticated: false, revoked: false});
  assert.deepEqual(fixture.posted.slice(1).map(request => [request.action, request.args]), [
    ['auth.status', {}], ['auth.signIn', {method: 'oauth', provider: 'test'}], ['auth.signIn', {method: 'passkey'}], ['auth.registerPasskey', {}], ['auth.syncWebSession', {}], ['auth.signOut', {}],
  ]);
});

test('malformed auth results fail closed instead of publishing authenticated state', async t => {
  const fixture = host(t, {hello: authHello, onPost(request, respond) { respond(request, {authenticated: true, user: {id: 'account-1'}, expiresAt: 'tomorrow'}); }});
  await assert.rejects(fixture.api.auth.status(), {code: 'INVALID_REQUEST'});
  await assert.rejects(fixture.api.auth.registerPasskey(), {code: 'INVALID_REQUEST'});
  await assert.rejects(fixture.api.auth.syncWebSession(), {code: 'INVALID_REQUEST'});
});

test('authentication cancellation before readiness never opens a late native prompt', async t => {
  const fixture = host(t, {deferHello: true});
  const controller = new AbortController();
  const operation = fixture.api.auth.signIn({method: 'passkey'}, {signal: controller.signal});
  const rejected = assert.rejects(operation, {code: 'CANCELLED'});
  controller.abort(); await rejected;
  fixture.respond(fixture.posted[0], authHello); await tick();
  assert.deepEqual(fixture.posted.map(request => request.action), ['hello']);
});

test('cancelling native auth sends cancellation and ignores late authenticated completion', async t => {
  const fixture = host(t, {hello: authHello});
  const controller = new AbortController();
  const operation = fixture.api.auth.signIn({method: 'oauth', provider: 'test'}, {signal: controller.signal});
  const rejected = assert.rejects(operation, {code: 'CANCELLED'});
  await tick();
  const request = fixture.posted.at(-1);
  assert.equal(request.action, 'auth.signIn');
  controller.abort(); await rejected;
  assert.equal(fixture.posted.at(-1).action, 'cancel');
  assert.equal(fixture.posted.at(-1).args.requestId, request.id);
  fixture.respond(request, signedIn);
});

test('auth events require a current subscription and expose only valid session summaries', async t => {
  const fixture = host(t, {hello: authHello, onPost(request, respond) { respond(request, null); }});
  const received = [];
  const stop = fixture.api.on('auth.changed', value => received.push(value));
  await tick();
  const subscription = fixture.posted.find(request => request.action === 'events.subscribe');
  const envelope = {v: 1, document: subscription.document, session: 'native-session', event: 'auth.changed', subscription: subscription.args.subscription};
  fixture.context.__spaReceive({...envelope, data: {...signedIn, refreshToken: 'native-secret'}});
  fixture.context.__spaReceive({...envelope, subscription: 'stale', data: {authenticated: false}});
  fixture.context.__spaReceive({...envelope, data: {authenticated: true}});
  stop();
  fixture.context.__spaReceive({...envelope, data: {authenticated: false}});
  assert.deepEqual(JSON.parse(JSON.stringify(received)), [signedIn]);
  assert.equal(Object.isFrozen(received[0]), true);
});


test('omitting plug-ins removes namespaces and subscription events from the assembled SDK', async t => {
  const fixture = host(t, {source: await assembleSDK({plugins: []})});
  assert.equal(Object.hasOwn(fixture.api, 'auth'), false);
  assert.equal(Object.hasOwn(fixture.api, 'storage'), false);
  assert.equal(Object.isFrozen(fixture.api), true);
  assert.throws(() => fixture.api.on('auth.changed', () => {}), {code: 'INVALID_REQUEST'});
  assert.equal(fixture.posted.length, 0);
});

test('storage facade is independently removable while auth and host APIs remain installed', async t => {
  const {loadSelectedPlugins} = await import('../../tooling/plugins.mjs');
  const plugins = loadSelectedPlugins().filter(plugin => plugin.id !== 'storage');
  const fixture = host(t, {source: await assembleSDK({plugins}), hello: authHello, onPost(request, respond) { respond(request, {authenticated: false, configured: false}); }});
  assert.equal(Object.hasOwn(fixture.api, 'storage'), false);
  assert.equal(typeof fixture.api.analytics.status, 'function');
  assert.equal((await fixture.api.auth.status()).authenticated, false);
});
