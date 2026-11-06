// Import-free installer: used directly as ESM and composed into the early
// browser bridge by the host's build-time plug-in registry.
export function installAuth(api) {
  const call = api.call;
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const error = (code, message) => new api.PlatformError(code, message);
  function authSummary(value) {
    if (!object(value) || typeof value.authenticated !== 'boolean') throw error('INVALID_REQUEST', 'Native authentication summary is invalid.');
    const result = {authenticated: value.authenticated};
    if (value.authenticated) {
      if (!object(value.user) || typeof value.user.id !== 'string' || !value.user.id || value.user.id.length > 256 || typeof value.user.name !== 'string' || value.user.name.length > 256 || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0) throw error('INVALID_REQUEST', 'Native authentication summary is invalid.');
      result.user = Object.freeze({id: value.user.id, name: value.user.name});
      result.expiresAt = value.expiresAt;
    }
    for (const key of ['configured', 'passkeys', 'revoked']) {
      if (value[key] !== undefined) {
        if (typeof value[key] !== 'boolean') throw error('INVALID_REQUEST', 'Native authentication summary is invalid.');
        result[key] = value[key];
      }
    }
    if (value.providers !== undefined) {
      if (!Array.isArray(value.providers) || value.providers.length > 32 || !value.providers.every(provider => typeof provider === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(provider))) throw error('INVALID_REQUEST', 'Native authentication providers are invalid.');
      result.providers = Object.freeze([...value.providers]);
    }
    // The facade intentionally returns summaries only, even if a host accidentally
    // includes credential fields. Provider tokens and cookies have no client API.
    return Object.freeze(result);
  }

  async function authCall(action, args = {}, options = {}) {
    if (!object(args)) throw error('INVALID_REQUEST', 'Authentication arguments are invalid.');
    const keys = Object.keys(args);
    if (action === 'auth.signIn') {
      const valid = args.method === 'oauth' ? keys.includes('method') && keys.length === 2 && keys.includes('provider') && typeof args.provider === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(args.provider) : args.method === 'passkey' && keys.length === 1 && keys[0] === 'method';
      if (!valid) throw error('INVALID_REQUEST', 'Choose an OAuth provider or passkey authentication.');
    } else if (keys.length) throw error('INVALID_REQUEST', 'This authentication operation takes no arguments.');
    const value = await call(action, args, options);
    if (action === 'auth.registerPasskey') {
      if (!object(value) || value.registered !== true) throw error('INVALID_REQUEST', 'Native passkey registration result is invalid.');
      return Object.freeze({registered: true});
    }
    if (action === 'auth.syncWebSession') {
      if (!object(value) || value.synchronized !== true) throw error('INVALID_REQUEST', 'Native web-session synchronization result is invalid.');
      return Object.freeze({synchronized: true});
    }
    return authSummary(value);
  }

  return Object.freeze({
    namespace: Object.freeze({
      status: (args = {}, options = {}) => authCall('auth.status', args, options),
      signIn: (args, options = {}) => authCall('auth.signIn', args, options),
      registerPasskey: (args = {}, options = {}) => authCall('auth.registerPasskey', args, options),
      signOut: (args = {}, options = {}) => authCall('auth.signOut', args, options),
      syncWebSession: (args = {}, options = {}) => authCall('auth.syncWebSession', args, options),
    }),
    normalizeEvent(name, data) { return name === 'auth.changed' ? authSummary(data) : data; },
  });
}
