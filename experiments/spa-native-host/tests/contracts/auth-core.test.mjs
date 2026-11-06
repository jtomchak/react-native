import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AuthStore, AuthService, random, digest, authenticationAdapters, validateAuthSettings, sessionCookie, handleAuth} from '@nativehost/auth/server';

async function harness(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'spa-auth-'));
  let now = Date.now();
  const file = path.join(dir, 'auth.sqlite');
  const store = new AuthStore(file, {now: () => now});
  const config = {origin: 'https://app.example.com', providers: {test: {issuer: 'https://issuer.example.com', clientId: 'test'}}, rpId: 'app.example.com', passkeyOrigins: ['https://app.example.com']};
  const adapters = {authorizationURL: async (id, tx) => `https://issuer.example.com/?state=${tx.state}`, verifyOAuth: async () => ({issuer: 'https://issuer.example.com', subject: 'one', name: 'Test user'})};
  const service = new AuthService(store, config, adapters, {now: () => now});
  t.after(async () => { store.close(); await rm(dir, {recursive: true, force: true}); });
  async function signIn() {
    const verifier = random();
    const start = await service.start({provider: 'test', challenge: digest(verifier), callbackURL: 'spahost-auth://callback'});
    const callback = new URL(await service.callback(new URL(`https://app.example.com/api/auth/oauth/callback/?state=${start.transaction}&code=provider-code`)));
    return service.redeem({code: callback.searchParams.get('code'), verifier});
  }
  return {service, store, config, file, signIn, advance: ms => { now += ms; }};
}

test('OAuth completion is proof-bound, single use, and preserves identity across logins', async t => {
  const {service, signIn} = await harness(t);
  const verifier = random();
  const {transaction} = await service.start({provider: 'test', challenge: digest(verifier), callbackURL: 'spahost-auth://callback'});
  const callback = new URL(await service.callback(new URL(`https://app.example.com/api/auth/oauth/callback/?state=${transaction}`)));
  const code = callback.searchParams.get('code');
  assert.throws(() => service.redeem({code, verifier: random()}), /UNAUTHORIZED/);
  const first = service.redeem({code, verifier});
  assert.throws(() => service.redeem({code, verifier}), /UNAUTHORIZED/);
  const second = await signIn();
  assert.equal(first.session.user.id, second.session.user.id);
  assert.notEqual(first.accessToken, second.accessToken);
  await assert.rejects(service.callback(new URL(`https://app.example.com/?state=${transaction}`)), /UNAUTHORIZED/);
});

test('OAuth rejects provider and callback substitution', async t => {
  const {service} = await harness(t);
  await assert.rejects(service.start({provider: 'other', challenge: random(), callbackURL: 'spahost-auth://callback'}));
  await assert.rejects(service.start({provider: 'test', challenge: random(), callbackURL: 'https://evil.example/'}));
});

test('OAuth failure never mints completion credentials', async t => {
  const {service, store} = await harness(t);
  service.adapters.verifyOAuth = async () => { throw new Error('invalid signature'); };
  const {transaction} = await service.start({provider: 'test', challenge: random(), callbackURL: 'spahost-auth://callback'});
  await assert.rejects(service.callback(new URL(`https://app.example.com/?state=${transaction}`)));
  assert.equal(store.list('completion').length, 0);
  assert.equal(store.list('group').length, 0);
});

test('web handoff requires matching native group, proof, and unused ticket', async t => {
  const {service, signIn} = await harness(t), one = await signIn(), two = await signIn();
  const verifier = random();
  const {ticket} = service.webTicket({challenge: digest(verifier), returnPath: '/hosted/auth/'}, one.accessToken);
  assert.throws(() => service.webSession({ticket, verifier}, two.accessToken), /UNAUTHORIZED/);
  assert.throws(() => service.webSession({ticket, verifier: random()}, one.accessToken), /UNAUTHORIZED/);
  const web = service.webSession({ticket, verifier}, one.accessToken);
  assert.equal(service.web(web.cookie).user.id, one.session.user.id);
  assert.throws(() => service.webSession({ticket, verifier}, one.accessToken), /UNAUTHORIZED/);
  service.logout(one.accessToken);
  assert.deepEqual(service.web(web.cookie), {authenticated: false});
  assert.equal(service.session(two.accessToken).authenticated, true);
});

test('ticket expiry and unsafe return paths do not grant a cookie', async t => {
  const {service, signIn, advance} = await harness(t), native = await signIn(), verifier = random();
  for (const returnPath of ['//evil.example/', '/hosted/../admin', '/hosted/%2fadmin', '/hosted/?token=secret']) assert.throws(() => service.webTicket({challenge: digest(verifier), returnPath}, native.accessToken));
  const {ticket} = service.webTicket({challenge: digest(verifier), returnPath: '/'}, native.accessToken);
  advance(30001);
  assert.throws(() => service.webSession({ticket, verifier}, native.accessToken), /UNAUTHORIZED/);
});

test('refresh rotates and replay revokes native and web siblings', async t => {
  const {service, signIn} = await harness(t), native = await signIn(), verifier = random();
  const {ticket} = service.webTicket({challenge: digest(verifier), returnPath: '/'}, native.accessToken);
  const {cookie} = service.webSession({ticket, verifier}, native.accessToken);
  const refreshed = service.refresh({refreshToken: native.refreshToken});
  assert.notEqual(refreshed.refreshToken, native.refreshToken);
  assert.equal(service.session(refreshed.accessToken).authenticated, true);
  assert.throws(() => service.refresh({refreshToken: native.refreshToken}), /UNAUTHORIZED/);
  assert.throws(() => service.session(refreshed.accessToken), /UNAUTHORIZED/);
  assert.deepEqual(service.web(cookie), {authenticated: false});
});

test('sessions survive reopening the durable store without storing plaintext tokens', async t => {
  const {service, signIn, file, store, config} = await harness(t), native = await signIn();
  assert.equal(store.db.prepare('SELECT data FROM records WHERE kind=\'access\'').get().data.includes(native.accessToken), false);
  const reopened = new AuthStore(file);
  t.after(() => reopened.close());
  const restarted = new AuthService(reopened, config, service.adapters);
  assert.equal(restarted.session(native.accessToken).user.id, native.session.user.id);
});

test('passkey registration needs authentication; malformed assertions cannot grant a session', async t => {
  const {service, store, config} = await harness(t);
  service.adapters = authenticationAdapters(config);
  await assert.rejects(service.passkeyOptions({operation: 'register'}), /UNAUTHORIZED/);
  const {transaction} = await service.passkeyOptions({operation: 'authenticate'});
  await assert.rejects(service.verifyPasskey({transaction, credential: {id: 'unknown', type: 'public-key', response: {}}}), /UNAUTHORIZED/);
  assert.equal(store.list('group').length, 0);
});

test('real verifier rejects a forged assertion against a stored public key', async t => {
  const {service, store, config, signIn} = await harness(t), native = await signIn();
  store.put('passkey', 'fake', {id: 'fake', userID: native.session.user.id, publicKey: 'AAAA', counter: 0}, Date.now() + 60000);
  service.adapters = authenticationAdapters(config);
  const {transaction, options} = await service.passkeyOptions({operation: 'authenticate'});
  await assert.rejects(service.verifyPasskey({transaction, credential: {id: 'fake', rawId: 'fake', type: 'public-key', response: {clientDataJSON: Buffer.from(JSON.stringify({type: 'webauthn.get', challenge: options.challenge, origin: config.origin})).toString('base64url'), authenticatorData: 'AAAA', signature: 'AAAA'}}}), /UNAUTHORIZED/);
  assert.equal(store.list('group').length, 1);
});

test('auth settings enforce production origins, RP association and private persistence', () => {
  const base = {origin: 'https://app.example.com', databasePath: '/private/auth.sqlite', providers: {}, rpId: 'app.example.com', passkeyOrigins: ['https://app.example.com']};
  assert.equal(validateAuthSettings(base).development, false);
  for (const patch of [{origin: 'http://app.example.com'}, {development: true}, {databasePath: './auth.sqlite'}, {rpId: 'evil.example'}, {passkeyOrigins: ['https://evil.example']}]) assert.throws(() => validateAuthSettings({...base, ...patch}));
  assert.match(sessionCookie({config: {development: false}}, 'abc'), /^__Host-spa_session=abc;.*HttpOnly.*Secure$/);
});

test('unconfigured auth routes fail closed without exposing server details', async () => {
  const original = process.env.SPA_AUTH_CONFIG_FILE;
  delete process.env.SPA_AUTH_CONFIG_FILE;
  try {
    const response = await handleAuth(new Request('https://app.example.com/api/auth/native/start/', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'}), ['native', 'start']);
    assert.equal(response.status, 503);
    assert.deepEqual((await response.json()).error.code, 'UNAVAILABLE');
  } finally { if (original === undefined) delete process.env.SPA_AUTH_CONFIG_FILE; else process.env.SPA_AUTH_CONFIG_FILE = original; }
});
