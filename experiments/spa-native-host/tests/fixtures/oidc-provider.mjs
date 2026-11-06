// Test-only identity provider. Binds loopback and auto-authorizes a fixed test
// identity. Never imported by the application or packaged as an auth provider.
import http from 'node:http';
import {generateKeyPairSync, sign, randomBytes, createHash} from 'node:crypto';
export async function startTestIdentityProvider({port = 0, hostname = 'localhost'} = {}) {
  const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
  const jwk = {...publicKey.export({format: 'jwk'}), kid: 'local-test', alg: 'RS256', use: 'sig'};
  const codes = new Map(); let origin;
  let fault = null;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    const json = (body, status = 200) => { res.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'}); res.end(JSON.stringify(body)); };
    if (url.pathname === '/.well-known/openid-configuration') return json({issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, jwks_uri: `${origin}/jwks`, response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256']});
    if (url.pathname === '/jwks') return json({keys: [jwk]});
    if (url.pathname === '/authorize') {
      if (url.searchParams.get('client_id') !== 'native-host-test' || url.searchParams.get('code_challenge_method') !== 'S256') return json({error: 'invalid_request'}, 400);
      const callback = new URL(url.searchParams.get('redirect_uri'));
      if (callback.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(callback.hostname) || callback.pathname !== '/api/auth/oauth/callback/') return json({error: 'invalid_request'}, 400);
      const code = randomBytes(32).toString('base64url');
      codes.set(code, {challenge: url.searchParams.get('code_challenge'), nonce: url.searchParams.get('nonce'), redirect: callback.href});
      callback.searchParams.set('code', code); callback.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, {location: callback.href}); return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      const input = new URLSearchParams(body), tx = codes.get(input.get('code'));
      codes.delete(input.get('code'));
      if (!tx || input.get('client_id') !== 'native-host-test' || tx.redirect !== input.get('redirect_uri') || tx.challenge !== createHash('sha256').update(input.get('code_verifier') ?? '').digest('base64url')) return json({error: 'invalid_grant'}, 400);
      const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
      const now = Math.floor(Date.now() / 1000);
      const data = `${encode({alg: 'RS256', kid: 'local-test', typ: 'JWT'})}.${encode({iss: origin, aud: 'native-host-test', sub: 'local-test-user', name: 'Local OAuth user', iat: now, exp: now + 300, nonce: fault === 'nonce' ? 'incorrect' : tx.nonce})}`;
      const signature = fault === 'signature' ? randomBytes(256) : sign('RSA-SHA256', Buffer.from(data), privateKey);
      return json({token_type: 'Bearer', access_token: randomBytes(32).toString('base64url'), expires_in: 300, id_token: `${data}.${signature.toString('base64url')}`});
    }
    return json({error: 'not_found'}, 404);
  });
  if (!['localhost', '127.0.0.1'].includes(hostname) || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Test identity provider must use loopback');
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  origin = `http://${hostname}:${server.address().port}`;
  return {origin, fault: value => { fault = value; }, close: () => new Promise(resolve => server.close(resolve))};
}
