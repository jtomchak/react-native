import {test, expect} from '@playwright/test';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import path from 'node:path';
import os from 'node:os';
import {randomBytes, createHash} from 'node:crypto';
import {startTestIdentityProvider} from '../fixtures/oidc-provider.mjs';
import {standaloneRoot, hostedEntry} from '../../tooling/hosted.mjs';
const origin = 'http://localhost:18801';
const nonce = () => randomBytes(32).toString('base64url');
const challenge = value => createHash('sha256').update(value).digest('base64url');
let provider, directory, server, native;
async function post(route, data, access, context = native) {
  return context.post(`${origin}/api/auth/${route}/`, {headers: {'content-type': 'application/json', ...(access ? {authorization: `Bearer ${access}`} : {})}, data});
}
async function signIn() {
  const verifier = nonce();
  const start = await post('native/start', {provider: 'test', challenge: challenge(verifier), callbackURL: 'spahost-auth://callback'});
  expect(start.status()).toBe(200);
  const authorize = await native.get((await start.json()).authorizationURL, {maxRedirects: 0});
  expect(authorize.status()).toBe(302);
  const identity = await native.get(authorize.headers().location, {maxRedirects: 0});
  const callback = await native.get(identity.headers().location, {maxRedirects: 0});
  return {callback, verifier};
}
async function credentials() {
  const {callback, verifier} = await signIn();
  expect(callback.status()).toBe(302);
  const code = new URL(callback.headers().location).searchParams.get('code');
  const response = await post('native/redeem', {code, verifier});
  expect(response.status()).toBe(200);
  return {value: await response.json(), code, verifier};
}
async function importWebSession(context, accessToken) {
  const verifier = nonce();
  const response = await post('native/web-ticket', {challenge: challenge(verifier), returnPath: '/hosted/auth/'}, accessToken);
  const {ticket} = await response.json();
  const installed = await post('native/web-session', {ticket, verifier}, accessToken);
  expect(installed.status()).toBe(200);
  const header = installed.headers()['set-cookie'];
  expect(header).toContain('HttpOnly'); expect(header).toContain('SameSite=Lax');
  const value = /^spa_dev_session=([^;]+)/.exec(header)[1];
  // Emulates native cookie-store import. This is not an OS-native prompt test.
  await context.addCookies([{name: 'spa_dev_session', value, url: origin, httpOnly: true, sameSite: 'Lax'}]);
  return {ticket, verifier};
}
test.beforeAll(async ({playwright}) => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'spa-auth-e2e-'));
  provider = await startTestIdentityProvider();
  const config = path.join(directory, 'auth.json');
  await writeFile(config, JSON.stringify({origin, development: true, databasePath: path.join(directory, 'auth.sqlite'), providers: {test: {issuer: provider.origin, clientId: 'native-host-test'}}, rpId: 'localhost', passkeyOrigins: [origin]}));
  server = spawn(process.execPath, [hostedEntry], {cwd: standaloneRoot, env: {...process.env, SPA_AUTH_CONFIG_FILE: config, HOSTNAME: '127.0.0.1', PORT: '18801', NODE_ENV: 'production'}, stdio: ['ignore', 'pipe', 'pipe']});
  let logs = ''; server.stdout.on('data', data => { logs += data; }); server.stderr.on('data', data => { logs += data; });
  native = await playwright.request.newContext();
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await native.get(`${origin}/api/health/`)).ok()) {
        // Initialize the shared service through the RSC module graph first.
        expect((await native.get(`${origin}/hosted/auth/`)).status()).toBe(200);
        return;
      }
    } catch {}
    if (server.exitCode !== null) throw new Error(`Auth test server exited: ${logs.slice(-3000)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Auth test server did not start: ${logs.slice(-3000)}`);
});
test.afterAll(async () => {
  await native?.dispose(); await provider?.close();
  if (server && server.exitCode === null) { const stopped = once(server, 'exit'); server.kill('SIGTERM'); await stopped; }
  if (directory) await rm(directory, {recursive: true, force: true});
});
test('real OIDC exchange, proof, cookie import, SSR identity and linked logout', async ({page, context}) => {
  const {value: session, code, verifier} = await credentials();
  expect((await post('native/redeem', {code, verifier})).status()).toBe(401);
  await page.goto('/hosted/auth/');
  await expect(page.getByTestId('auth-server-status')).toHaveText('Server anonymous');
  const ticket = await importWebSession(context, session.accessToken);
  expect((await post('native/web-session', ticket, session.accessToken)).status()).toBe(401);
  await page.reload();
  await expect(page.getByTestId('auth-server-status')).toHaveText('Server authenticated: Local OAuth user');
  await expect(page.getByTestId('auth-server-user')).toHaveText(session.session.user.id);
  expect(await page.evaluate(() => document.cookie.includes('spa_dev_session'))).toBe(false);
  expect((await post('native/web-session', {ticket: nonce(), verifier: nonce()})).status()).toBe(401);
  await post('native/logout', {}, session.accessToken);
  await page.reload(); await expect(page.getByTestId('auth-server-status')).toHaveText('Server anonymous');
});
test('OIDC invalid nonce and invalid signature fail closed', async () => {
  try { for (const fault of ['nonce', 'signature']) { provider.fault(fault); const {callback} = await signIn(); expect(callback.status()).toBe(401); expect(callback.headers().location).toBeUndefined(); } }
  finally { provider.fault(null); }
});
test('SSR-first initialization preserves auth errors and blocks cross-origin handoffs', async ({page}) => {
  await page.goto('/hosted/auth/');
  await expect(page.getByTestId('auth-server-status')).toHaveText('Server anonymous');
  expect((await post('native/session', {}, nonce())).status()).toBe(401);
  const crossOrigin = await native.post(`${origin}/api/auth/native/start/`, {headers: {'content-type': 'application/json', origin: 'https://untrusted.example'}, data: {provider: 'test', challenge: nonce(), callbackURL: 'spahost-auth://callback'}});
  expect(crossOrigin.status()).toBe(401);
  const wrongHost = await native.get(`${origin}/api/auth/web/session/`, {headers: {host: 'untrusted.example', 'x-forwarded-host': 'localhost:18801'}});
  expect(wrongHost.status()).toBe(401);
});
test('real WebAuthn registration and assertion with a browser virtual authenticator', async ({page, context}) => {
  const {value: session} = await credentials();
  await page.goto('/hosted/auth/');
  const cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
  const {authenticatorId} = await cdp.send('WebAuthn.addVirtualAuthenticator', {options: {protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true}});
  try {
    async function ceremony(operation, access) {
      const response = await post('passkeys/options', {operation}, access); expect(response.status()).toBe(200);
      const {transaction, options} = await response.json();
      const credential = await page.evaluate(async ({operation, options}) => {
        const decode = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
        const encode = value => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
        options.challenge = decode(options.challenge);
        if (operation === 'register') { options.user.id = decode(options.user.id); options.excludeCredentials = options.excludeCredentials.map(key => ({...key, id: decode(key.id)})); }
        else options.allowCredentials = options.allowCredentials?.map(key => ({...key, id: decode(key.id)}));
        const value = await navigator.credentials[operation === 'register' ? 'create' : 'get']({publicKey: options});
        const response = {clientDataJSON: encode(value.response.clientDataJSON)};
        for (const key of ['attestationObject', 'authenticatorData', 'signature', 'userHandle']) if (value.response[key]) response[key] = encode(value.response[key]);
        if (value.response.getTransports) response.transports = value.response.getTransports();
        return {id: value.id, rawId: encode(value.rawId), type: value.type, response, clientExtensionResults: value.getClientExtensionResults()};
      }, {operation, options});
      return {response: await post('passkeys/verify', {transaction, credential}, access), transaction, credential};
    }
    expect((await ceremony('register', session.accessToken)).response.status()).toBe(200);
    await post('native/logout', {}, session.accessToken);
    const result = await ceremony('authenticate'); expect(result.response.status()).toBe(200);
    const signedIn = await result.response.json(); expect(signedIn.session.user.id).toBe(session.session.user.id);
    expect((await post('passkeys/verify', {transaction: result.transaction, credential: result.credential})).status()).toBe(401);
    await importWebSession(context, signedIn.accessToken); await page.reload();
    await expect(page.getByTestId('auth-server-user')).toHaveText(session.session.user.id);
  } finally { await cdp.send('WebAuthn.removeVirtualAuthenticator', {authenticatorId}); await cdp.detach(); }
});
