// Public client options only. Server secrets have a separate private config.
export function validateConfiguration(value, host = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['enabled', 'origin', 'providers', 'rpId'].includes(key)) || ['enabled', 'origin', 'providers', 'rpId'].some(key => !Object.hasOwn(value, key))) throw new Error('Invalid auth plug-in configuration');
  if (typeof value.enabled !== 'boolean' || !Array.isArray(value.providers) || value.providers.length > 8 || new Set(value.providers).size !== value.providers.length || value.providers.some(id => typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(id))) throw new Error('Invalid auth providers');
  let url;
  if (value.origin !== null) {
    try { url = new URL(value.origin); } catch { throw new Error('Auth requires an exact HTTPS origin'); }
    if (url.protocol !== 'https:' || value.origin !== url.origin || url.username || url.password || url.hostname.endsWith('.')) throw new Error('Auth requires an exact HTTPS origin');
  }
  if (value.enabled && !url) throw new Error('Auth requires an origin');
  if (value.rpId !== null && (typeof value.rpId !== 'string' || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(value.rpId) || value.rpId.length > 253 || !url || !(url.hostname === value.rpId || url.hostname.endsWith(`.${value.rpId}`)))) throw new Error('Invalid auth relying party');
  if (value.enabled && host.content?.mode === 'hosted' && value.origin !== host.content.origin) throw new Error('Hosted auth must use the hosted origin');
  return structuredClone(value);
}
