import {createHash, randomBytes, randomUUID} from 'node:crypto';

export const random = () => randomBytes(32).toString('base64url');
export const digest = value => createHash('sha256').update(value).digest('base64url');
const minute = 60000, day = 86400000, forever = 8640000000000000;
const authErrorTag = Symbol.for('spa.native.auth.error');
export class AuthError extends Error {
  constructor(code = 'UNAUTHORIZED', status = 401) { super(code); this.code = code; this.status = status; Object.defineProperty(this, authErrorTag, {value: true}); }
}
// Next's RSC and route-handler graphs may load distinct class constructors while
// sharing the process-owned service. A local instanceof check is insufficient.
export function isAuthError(error) {
  return error?.[authErrorTag] === true && ['UNAUTHORIZED', 'INVALID_REQUEST', 'UNAVAILABLE', 'QUOTA_EXCEEDED'].includes(error.code) && [400, 401, 405, 429, 503].includes(error.status);
}
export function requireValue(condition, code = 'INVALID_REQUEST', status = 400) { if (!condition) throw new AuthError(code, status); }
export function fields(value, allowed, required = allowed) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key)));
}
export function token(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value); }
export function returnPath(value) {
  return typeof value === 'string' && value.length <= 1024 && /^\/(?:hosted\/[a-zA-Z0-9/_-]*|compose\/|library\/)?$/.test(value);
}

export class AuthService {
  constructor(store, config, adapters, {now = Date.now} = {}) { this.store = store; this.config = config; this.adapters = adapters; this.now = now; }
  summary(group) {
    const user = this.store.get('user', group.userID);
    requireValue(user, 'UNAUTHORIZED', 401);
    return {authenticated: true, user: {id: user.id, name: user.name}, expiresAt: group.expiresAt};
  }
  group(accessToken) {
    requireValue(token(accessToken), 'UNAUTHORIZED', 401);
    const access = this.store.get('access', digest(accessToken));
    const group = access && this.store.get('group', access.groupID);
    requireValue(group, 'UNAUTHORIZED', 401);
    return group;
  }
  credentials(group) {
    const accessToken = random(), refreshToken = random();
    this.store.put('access', digest(accessToken), {groupID: group.id}, this.now() + 10 * minute);
    this.store.put('refresh', digest(refreshToken), {groupID: group.id}, group.expiresAt);
    return {accessToken, refreshToken, session: this.summary(group)};
  }
  newSession(userID) {
    const group = {id: randomUUID(), userID, expiresAt: this.now() + 30 * day};
    this.store.put('group', group.id, group, group.expiresAt);
    return this.credentials(group);
  }
  identity(issuer, subject, name) {
    requireValue(typeof subject === 'string' && subject.length > 0 && subject.length < 1024, 'UNAUTHORIZED', 401);
    const key = digest(JSON.stringify([issuer, subject]));
    let identity = this.store.get('identity', key);
    if (!identity) {
      const user = {id: randomUUID(), name: typeof name === 'string' && name.trim() ? name.slice(0, 128) : 'Signed-in user'};
      this.store.put('user', user.id, user, forever);
      identity = {userID: user.id}; this.store.put('identity', key, identity, forever);
    }
    return identity.userID;
  }
  async start(input) {
    fields(input, ['provider', 'challenge', 'callbackURL']);
    requireValue(typeof input.provider === 'string' && Object.hasOwn(this.config.providers, input.provider) && token(input.challenge) && input.callbackURL === 'spahost-auth://callback');
    const id = random();
    this.store.atomic(() => this.store.put('oauth', id, {...input, verifier: random(), nonce: random()}, this.now() + 5 * minute));
    return {transaction: id, authorizationURL: `${this.config.origin}/api/auth/oauth/authorize/?transaction=${id}`};
  }
  async authorize(id) {
    requireValue(token(id));
    const tx = this.store.get('oauth', id); requireValue(tx, 'UNAUTHORIZED', 401);
    return this.adapters.authorizationURL(tx.provider, {state: id, nonce: tx.nonce, challenge: digest(tx.verifier)});
  }
  async callback(url) {
    const id = url.searchParams.get('state'); requireValue(token(id));
    const tx = this.store.atomic(() => { const value = this.store.get('oauth', id); requireValue(value, 'UNAUTHORIZED', 401); this.store.remove('oauth', id); return value; });
    const identity = await this.adapters.verifyOAuth(tx.provider, url, {state: id, nonce: tx.nonce, verifier: tx.verifier});
    const code = random();
    this.store.atomic(() => {
      const userID = this.identity(identity.issuer, identity.subject, identity.name);
      this.store.put('completion', digest(code), {userID, challenge: tx.challenge}, this.now() + minute);
    });
    return `${tx.callbackURL}?code=${code}`;
  }
  redeem(input) {
    fields(input, ['code', 'verifier']); requireValue(token(input.code) && token(input.verifier));
    return this.store.atomic(() => {
      const key = digest(input.code), tx = this.store.get('completion', key);
      requireValue(tx && tx.challenge === digest(input.verifier), 'UNAUTHORIZED', 401);
      this.store.remove('completion', key);
      return this.newSession(tx.userID);
    });
  }
  session(access) { return this.summary(this.group(access)); }
  refresh(input) {
    fields(input, ['refreshToken']); requireValue(token(input.refreshToken));
    const key = digest(input.refreshToken);
    // Commit replay revocation even though the request fails afterward.
    const result = this.store.atomic(() => {
      const previous = this.store.get('rotated', key);
      if (previous) { this.store.remove('group', previous.groupID); return null; }
      const refresh = this.store.get('refresh', key), group = refresh && this.store.get('group', refresh.groupID);
      if (!group) return null;
      this.store.remove('refresh', key);
      this.store.put('rotated', key, refresh, group.expiresAt);
      return this.credentials(group);
    });
    requireValue(result, 'UNAUTHORIZED', 401); return result;
  }
  logout(access) {
    return this.store.atomic(() => { const group = this.group(access); this.store.remove('group', group.id); return {authenticated: false}; });
  }
  webTicket(input, access) {
    fields(input, ['challenge', 'returnPath']); requireValue(token(input.challenge) && returnPath(input.returnPath));
    return this.store.atomic(() => {
      const group = this.group(access), ticket = random();
      this.store.put('ticket', digest(ticket), {groupID: group.id, challenge: input.challenge, path: input.returnPath}, this.now() + 30000);
      return {ticket};
    });
  }
  webSession(input, access) {
    fields(input, ['ticket', 'verifier']); requireValue(token(input.ticket) && token(input.verifier));
    return this.store.atomic(() => {
      const group = this.group(access), key = digest(input.ticket), ticket = this.store.get('ticket', key);
      requireValue(ticket && ticket.groupID === group.id && ticket.challenge === digest(input.verifier), 'UNAUTHORIZED', 401);
      this.store.remove('ticket', key);
      const cookie = random(); this.store.put('web', digest(cookie), {groupID: group.id}, Math.min(group.expiresAt, this.now() + 2 * 60 * minute));
      return {cookie, session: this.summary(group)};
    });
  }
  web(cookie) {
    if (!token(cookie)) return {authenticated: false};
    const web = this.store.get('web', digest(cookie)), group = web && this.store.get('group', web.groupID);
    return group ? this.summary(group) : {authenticated: false};
  }
  logoutWeb(cookie) {
    return this.store.atomic(() => {
      const web = token(cookie) && this.store.get('web', digest(cookie));
      if (web) { this.store.remove('group', web.groupID); this.store.remove('web', digest(cookie)); }
      return {authenticated: false};
    });
  }
  async passkeyOptions(input, access) {
    fields(input, ['operation']); requireValue(['authenticate', 'register'].includes(input.operation));
    requireValue(this.config.rpId, 'UNAVAILABLE', 503);
    const group = input.operation === 'register' ? this.group(access) : null;
    const user = group ? this.store.get('user', group.userID) : null;
    const owned = user ? this.store.list('passkey').filter(key => key.userID === user.id) : [];
    requireValue(owned.length < 32, 'QUOTA_EXCEEDED', 429);
    const options = await this.adapters.passkeyOptions(input.operation, user, owned);
    const transaction = random();
    this.store.atomic(() => this.store.put('ceremony', transaction, {operation: input.operation, challenge: options.challenge, ...(group ? {groupID: group.id, userID: group.userID} : {})}, this.now() + 2 * minute));
    return {transaction, options};
  }
  async verifyPasskey(input, access) {
    fields(input, ['transaction', 'credential']); requireValue(token(input.transaction));
    fields(input.credential, ['id', 'rawId', 'response', 'type', 'clientExtensionResults', 'authenticatorAttachment'], ['id', 'response', 'type']);
    requireValue(input.credential.type === 'public-key' && typeof input.credential.id === 'string' && /^[A-Za-z0-9_-]{1,2048}$/.test(input.credential.id));
    const tx = this.store.atomic(() => {
      const tx = this.store.get('ceremony', input.transaction); requireValue(tx, 'UNAUTHORIZED', 401);
      if (tx.operation === 'register') requireValue(this.group(access).id === tx.groupID, 'UNAUTHORIZED', 401);
      this.store.remove('ceremony', input.transaction); return tx;
    });
    const saved = this.store.get('passkey', input.credential.id);
    if (tx.operation === 'authenticate') {
      requireValue(saved, 'UNAUTHORIZED', 401);
      const handle = input.credential.response?.userHandle;
      requireValue(handle == null || handle === Buffer.from(saved.userID).toString('base64url'), 'UNAUTHORIZED', 401);
    }
    const result = await this.adapters.verifyPasskey(tx, input.credential, saved);
    requireValue(result.verified, 'UNAUTHORIZED', 401);
    return this.store.atomic(() => {
      if (tx.operation === 'register') {
        requireValue(this.group(access).id === tx.groupID && !this.store.get('passkey', result.credential.id), 'UNAUTHORIZED', 401);
        requireValue(this.store.list('passkey').filter(key => key.userID === tx.userID).length < 32, 'QUOTA_EXCEEDED', 429);
        this.store.put('passkey', result.credential.id, {...result.credential, userID: tx.userID}, forever);
        return {registered: true};
      }
      // Re-check state after async signature verification: never resurrect a
      // removed credential or overwrite a concurrent counter update.
      const current = this.store.get('passkey', saved.id);
      requireValue(current && current.counter === saved.counter, 'UNAUTHORIZED', 401);
      this.store.put('passkey', saved.id, {...current, counter: result.newCounter}, forever);
      return this.newSession(saved.userID);
    });
  }
}
