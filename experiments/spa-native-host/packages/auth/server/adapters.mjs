import * as oidc from 'openid-client';
import {generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse} from '@simplewebauthn/server';
import {AuthError, requireValue} from './core.mjs';

export function authenticationAdapters(settings) {
  const configurations = new Map();
  async function provider(id) {
    if (!configurations.has(id)) {
      const input = settings.providers[id]; requireValue(input, 'UNAVAILABLE', 503);
      const secret = input.clientSecretEnv ? process.env[input.clientSecretEnv] : undefined;
      requireValue(!input.clientSecretEnv || secret, 'UNAVAILABLE', 503);
      const options = {timeout: 10, execute: [oidc.enableNonRepudiationChecks]};
      if (settings.development && new URL(input.issuer).protocol === 'http:') options.execute.push(oidc.allowInsecureRequests);
      configurations.set(id, oidc.discovery(new URL(input.issuer), input.clientId, secret, undefined, options).catch(error => { configurations.delete(id); throw error; }));
    }
    return configurations.get(id);
  }
  return {
    async authorizationURL(id, tx) {
      return oidc.buildAuthorizationUrl(await provider(id), {redirect_uri: `${settings.origin}/api/auth/oauth/callback/`, response_type: 'code', scope: 'openid profile', state: tx.state, nonce: tx.nonce, code_challenge: tx.challenge, code_challenge_method: 'S256'}).href;
    },
    async verifyOAuth(id, url, tx) {
      try {
        const config = await provider(id);
        const result = await oidc.authorizationCodeGrant(config, url, {pkceCodeVerifier: tx.verifier, expectedState: tx.state, expectedNonce: tx.nonce, idTokenExpected: true});
        const claims = result.claims();
        requireValue(claims && typeof claims.sub === 'string', 'UNAUTHORIZED', 401);
        return {issuer: config.serverMetadata().issuer, subject: claims.sub, name: claims.name};
      } catch { throw new AuthError(); }
    },
    async passkeyOptions(operation, user, saved) {
      if (operation === 'authenticate') return generateAuthenticationOptions({rpID: settings.rpId, userVerification: 'required', timeout: 60000});
      return generateRegistrationOptions({rpName: 'Native Host', rpID: settings.rpId, userID: new Uint8Array(Buffer.from(user.id)), userName: user.id, userDisplayName: user.name, timeout: 60000, attestationType: 'none', supportedAlgorithmIDs: [-7, -257], excludeCredentials: saved.map(key => ({id: key.id, transports: key.transports})), authenticatorSelection: {residentKey: 'required', userVerification: 'required'}});
    },
    async verifyPasskey(tx, response, saved) {
      try {
        const checks = {response, expectedChallenge: tx.challenge, expectedOrigin: settings.passkeyOrigins, expectedRPID: settings.rpId, requireUserVerification: true};
        if (tx.operation === 'register') {
          const result = await verifyRegistrationResponse({...checks, supportedAlgorithmIDs: [-7, -257]});
          if (!result.verified) return {verified: false};
          const key = result.registrationInfo.credential;
          return {verified: true, credential: {id: key.id, publicKey: Buffer.from(key.publicKey).toString('base64url'), counter: key.counter, transports: key.transports ?? []}};
        }
        const result = await verifyAuthenticationResponse({...checks, credential: {id: saved.id, publicKey: new Uint8Array(Buffer.from(saved.publicKey, 'base64url')), counter: saved.counter, transports: saved.transports}});
        return {verified: result.verified, newCounter: result.authenticationInfo?.newCounter};
      } catch { throw new AuthError(); }
    },
  };
}
