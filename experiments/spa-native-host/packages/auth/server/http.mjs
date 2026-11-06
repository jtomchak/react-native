import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {AuthStore} from './store.mjs';
import {AuthService, AuthError, isAuthError, fields, requireValue} from './core.mjs';
import {authenticationAdapters} from './adapters.mjs';

const loopbacks = ['127.0.0.1', 'localhost', '[::1]'];
export function validateAuthSettings(value) {
  fields(value, ['origin', 'development', 'databasePath', 'providers', 'rpId', 'passkeyOrigins'], ['origin', 'databasePath', 'providers', 'rpId', 'passkeyOrigins']);
  const origin = new URL(value.origin);
  const development = value.development === true;
  requireValue(value.development === undefined || typeof value.development === 'boolean');
  requireValue(value.origin === origin.origin && (origin.protocol === 'https:' || (development && origin.protocol === 'http:' && loopbacks.includes(origin.hostname))));
  requireValue(!development || loopbacks.includes(origin.hostname));
  requireValue(typeof value.databasePath === 'string' && path.isAbsolute(value.databasePath) && !value.databasePath.includes('/public/') && !value.databasePath.includes('/build/web/'));
  requireValue(value.providers && typeof value.providers === 'object' && !Array.isArray(value.providers) && Object.keys(value.providers).length <= 8);
  for (const [id, provider] of Object.entries(value.providers)) {
    requireValue(/^[a-z][a-z0-9_-]{0,31}$/.test(id));
    fields(provider, ['issuer', 'clientId', 'clientSecretEnv'], ['issuer', 'clientId']);
    const issuer = new URL(provider.issuer);
    requireValue(!issuer.username && !issuer.password && !issuer.search && !issuer.hash && (issuer.protocol === 'https:' || (development && issuer.protocol === 'http:' && loopbacks.includes(issuer.hostname))));
    requireValue(typeof provider.clientId === 'string' && provider.clientId.length > 0 && provider.clientId.length < 256);
    requireValue(provider.clientSecretEnv === undefined || /^[A-Z][A-Z0-9_]{1,127}$/.test(provider.clientSecretEnv));
  }
  requireValue(value.rpId === null || (typeof value.rpId === 'string' && /^[a-z0-9][a-z0-9.-]{0,251}[a-z0-9]$/.test(value.rpId) && (origin.hostname === value.rpId || origin.hostname.endsWith(`.${value.rpId}`))));
  requireValue(Array.isArray(value.passkeyOrigins) && value.passkeyOrigins.length <= 16 && (value.rpId === null || value.passkeyOrigins.length > 0));
  for (const allowed of value.passkeyOrigins) {
    if (/^android:apk-key-hash:[A-Za-z0-9_-]{43}$/.test(allowed)) continue;
    const url = new URL(allowed);
    requireValue(allowed === url.origin && (url.protocol === 'https:' || (development && url.protocol === 'http:' && loopbacks.includes(url.hostname))) && (url.hostname === value.rpId || url.hostname.endsWith(`.${value.rpId}`)));
  }
  return {...value, development};
}

export async function authService() {
  const file = process.env.SPA_AUTH_CONFIG_FILE;
  if (!file) return null;
  requireValue(path.isAbsolute(file), 'UNAVAILABLE', 503);
  const instances = globalThis[Symbol.for('spa.native.auth.instances')] ??= new Map();
  if (!instances.has(file)) {
    const raw = await readFile(file); requireValue(raw.length <= 32768, 'UNAVAILABLE', 503);
    const config = validateAuthSettings(JSON.parse(raw.toString('utf8')));
    const store = new AuthStore(config.databasePath);
    instances.set(file, new AuthService(store, config, authenticationAdapters(config)));
  }
  return instances.get(file);
}
export function cookieName(service) { return service.config.development ? 'spa_dev_session' : '__Host-spa_session'; }
export function sessionCookie(service, value, clear = false) {
  return `${cookieName(service)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : 7200}${service.config.development ? '' : '; Secure'}`;
}
export function cookieValue(service, header = '') {
  const name = cookieName(service);
  const matches = header.split(';').map(item => item.trim()).filter(item => item.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : '';
}
export const authHeaders = {'Cache-Control': 'no-store, private', 'Pragma': 'no-cache', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff'};
function bearer(request) { return /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') ?? '')?.[1]; }
async function input(request) {
  requireValue(request.headers.get('content-type')?.split(';')[0].trim() === 'application/json');
  const announced = request.headers.get('content-length');
  requireValue(!announced || /^\d+$/.test(announced) && Number(announced) <= 65536);
  requireValue(request.body);
  const reader = request.body.getReader(), chunks = []; let count = 0;
  try {
    for (;;) { const {done, value} = await reader.read(); if (done) break; count += value.length; requireValue(count <= 65536); chunks.push(value); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { await reader.cancel().catch(() => {}); throw new AuthError('INVALID_REQUEST', 400); }
}
export async function handleAuth(request, operation) {
  const response = (body, status = 200, extra = {}) => Response.json(body, {status, headers: {...authHeaders, ...extra}});
  try {
    const service = await authService(); requireValue(service, 'UNAVAILABLE', 503);
    const incoming = new URL(request.url);
    // Next may reconstruct request.url with its internal listener hostname
    // (localhost), even when the actual Host is a configured loopback address.
    // Validate the exact public authority; never trust X-Forwarded-Host. Use the
    // configured origin for OAuth callback reconstruction and HTTPS policy.
    requireValue(request.headers.get('host')?.toLowerCase() === new URL(service.config.origin).host, 'UNAUTHORIZED', 401);
    const url = new URL(service.config.origin);
    url.pathname = incoming.pathname;
    url.search = incoming.search;
    const origin = request.headers.get('origin');
    requireValue(!origin || origin === service.config.origin, 'UNAUTHORIZED', 401);
    const route = operation.join('/');
    if (request.method === 'GET') {
      if (route === 'web/session') return response(service.web(cookieValue(service, request.headers.get('cookie') ?? '')));
      if (route === 'oauth/authorize') {
        const location = await service.authorize(url.searchParams.get('transaction'));
        return new Response(null, {status: 302, headers: {...authHeaders, Location: location}});
      }
      if (route === 'oauth/callback') {
        const location = await service.callback(url);
        return new Response(null, {status: 302, headers: {...authHeaders, Location: location}});
      }
      return response({error: {code: 'INVALID_REQUEST', message: 'Unknown authentication operation'}}, 404);
    }
    requireValue(request.method === 'POST', 'INVALID_REQUEST', 405);
    const body = await input(request), access = bearer(request);
    switch (route) {
      case 'native/start': return response(await service.start(body));
      case 'native/redeem': return response(service.redeem(body));
      case 'native/session': fields(body, []); return response(service.session(access));
      case 'native/refresh': return response(service.refresh(body));
      case 'native/logout': fields(body, []); return response(service.logout(access));
      case 'native/web-ticket': return response(service.webTicket(body, access));
      case 'native/web-session': {
        const result = service.webSession(body, access);
        return response(result.session, 200, {'Set-Cookie': sessionCookie(service, result.cookie)});
      }
      case 'passkeys/options': return response(await service.passkeyOptions(body, access));
      case 'passkeys/verify': return response(await service.verifyPasskey(body, access));
      case 'web/logout': {
        fields(body, []); requireValue(origin === service.config.origin, 'UNAUTHORIZED', 401);
        return response(service.logoutWeb(cookieValue(service, request.headers.get('cookie') ?? '')), 200, {'Set-Cookie': sessionCookie(service, '', true)});
      }
      default: return response({error: {code: 'INVALID_REQUEST', message: 'Unknown authentication operation'}}, 404);
    }
  } catch (error) {
    const known = isAuthError(error);
    return response({error: {code: known ? error.code : 'UNAVAILABLE', message: known && error.code === 'UNAUTHORIZED' ? 'Authentication was not accepted' : 'Authentication operation unavailable or invalid'}}, known ? error.status : 503);
  }
}
