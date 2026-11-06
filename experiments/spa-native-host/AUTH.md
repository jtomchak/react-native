# Native authentication prototype

The host owns OAuth presentation, passkey prompts and native credentials. The
server owns identity and a group of linked native/web sessions. Hosted Next.js
receives its own HttpOnly cookie; credentials never pass through page JavaScript.
Both native hosts use the existing origin/document bridge admission and native
presentation lease. There is no CocoaPods dependency.

## Implemented boundaries

- iOS AuthenticationServices external OAuth session, native passkey registration
  and authentication, Keychain credentials scoped by auth origin.
- Android Custom Tabs OAuth and Credential Manager passkeys, app-owned encrypted
  Keystore credential vault, exact auth callback consumed before deep-link routes.
- Server OIDC code flow: discovery, S256 PKCE, state, nonce, issuer/audience and
  ID-token signature verification via openid-client. Identity keys use issuer and
  subject; matching emails never automatically link accounts.
- SimpleWebAuthn generates challenges and verifies passkey ceremonies, user
  verification, permitted origins and RP ID. Native sign-in requires server
  signature verification, not a local biometric-success boolean.
- Durable, transactional SQLite session store. Single-use completion codes and
  handoff tickets, expiring access/web credentials, rotating native refresh
  credentials, and device-group revocation. Replay of a rotated refresh token
  revokes the group. Challenges and credential tokens use OS/Node cryptographic
  randomness. Persisted access, refresh, completion and web tokens are hashed.
- Browser-facing SDK/React hooks return sanitized summaries. Hosted identity
  changes and completed sync/logout force a fresh document to retire Next's
  client routing cache. Native auth revisions retire old hosted JavaScript realms
  before cookie replacement and reload before revealing them, including native
  back navigation. Server
  operations always validate the session.

## Cookie handoff

`auth.syncWebSession()` requires hosted content at the exact auth origin. Native
obtains a 30-second ticket bound to its session group and a SHA-256 proof. Native
redeems it with bearer authentication plus the proof, then imports only the
server-issued session cookie through WKHTTPCookieStore/Android CookieManager.
Only after cookie installation does the bridge acknowledge success. The client
then reloads. No ticket/token/cookie getter is available to page JavaScript.

The hosted `useAuth().signIn()` helper chains native sign-in and web sync under
one busy operation. A failed sync attempts native sign-out rollback before
reloading. The framework-independent primitive remains explicit:
`platform.auth.signIn(...)`, then `platform.auth.syncWebSession()` for hosted
content. Plain HTML integrations must perform that chain; retained hosted content
is concealed during the identity transition. Packaged sign-in needs no cookie.

This deliberately replaces the proposed browser-form bootstrap. Requiring native
authorization on redemption avoids exposing a public login form that can install
another account's session. A normal native HTTP cookie jar is not assumed to be
the WebView's jar.

Production cookie: `__Host-spa_session; Secure; HttpOnly; SameSite=Lax; Path=/`.
The explicit loopback-only test configuration uses `spa_dev_session` on HTTP.
No Secure-cookie downgrade is selected from a browser parameter or request host.

## Configuration

Live providers are disabled by default. Never place OAuth client secrets, provider
refresh tokens, or the server database in bundled assets.

Public plug-in configuration (`configuration/plugins.json`):

```json
{
  "schemaVersion": 1,
  "plugins": [{
    "package": "@nativehost/auth",
    "configuration": {
      "enabled": true,
      "origin": "https://app.example.com",
      "providers": ["company"],
      "rpId": "app.example.com"
    }
  }]
}
```

The host generates bundled `plugins.auth` settings from that declaration. See
[PLUGINS.md](PLUGINS.md) for installation, removal and native package integration.
Hosted v1 requires `content.origin` to equal the auth service origin. Packaged content can
sign in, query native session state, enroll passkeys and sign out; web-cookie sync
is intentionally unavailable there. It does not grant a generic authenticated
fetch proxy or make offline authorization authoritative.

Server configuration: copy `configuration/auth-server.example.json` to a private
location, edit its origin/database/providers, and set `SPA_AUTH_CONFIG_FILE` to
its absolute path. Run Node 24+. A `clientSecretEnv` value names an environment
variable; it is not the secret itself. Configure the provider's registered
redirect as `https://app.example.com/api/auth/oauth/callback/`. No inferred
Firebase Messaging configuration is used for identity.
Restart the server after editing this configuration. A reverse proxy must
preserve the configured public Host authority; auth does not trust a supplied
`X-Forwarded-Host` to grant a different origin.

The native completion callback is exactly `spahost-auth://callback?code=...`.
It accepts a one-use code bound to a native verifier, never a reusable token.
Configured claimed HTTPS callbacks can be added later with domain association;
they are not claimed implemented by this prototype.

Missing or invalid server configuration fails closed. No development identity
provider is imported by the application. The test issuer lives under tests only,
binds loopback, and is started explicitly by the acceptance harness.

## Passkey website associations

Choose the RP domain before enrollment. Existing credentials are scoped to it.

- Apple: configure `webcredentials:<rpId>` and serve the AASA `webcredentials`
  entry for the signed app ID. Build with `SPA_ENABLE_PASSKEYS=1` using the
  existing iOS build script. This requires an appropriate signing profile;
  no production domain/profile was registered in this change.
- Android: serve `/.well-known/assetlinks.json` for the package and actual signing
  certificate. Add each approved native `android:apk-key-hash:<base64url SHA256>`
  origin to the server's `passkeyOrigins`. Keep debug signing identities out of
  production configuration. The relationship is independent of App Links.
- Website: allow only the intended HTTPS web origins under the configured RP.

Registration requires an existing authenticated session (initially OAuth). The
prototype has no anonymous enrollment, email account merge, recovery, passkey
management/delete UI, or recent-authentication step-up policy. Those require
explicit account lifecycle design before production adoption.

## Session lifecycle

Access tokens last ten minutes; native session groups/refresh credentials last
30 days; web cookies expire after two hours. Native operations validate access
and refresh once when required. Refresh work remains serialized through UI
cancellation, and a returned rotation is checkpointed before downstream work.
Loss of a refresh response after server commit can still require reauthentication;
there is no assertion of exactly-once delivery across network failure.

Native logout clears local credentials and the agreed WebView cookie and reports
`revoked:false` if server revocation could not be confirmed. Remote sessions may
remain valid in that case. Web logout requires a same-origin POST and revokes the
linked group. Provider-wide SSO logout is a separate concern.

## Verification

Run from this prototype directory:

```sh
npm test
npm run export
npm run hosted:build
npm run test:auth
```

`test:auth` owns a loopback production Next server and an isolated OIDC issuer.
It verifies the actual code/token/signature path, rejects invalid nonce/signature,
imports the issued HttpOnly cookie into a separate browser context, checks SSR
identity, verifies linked logout and replay rejection, and completes real WebAuthn
cryptography with a Chromium virtual authenticator. It emulates the native cookie
import; it is not evidence of an OS-native passkey prompt.

For Android device OAuth acceptance, `node tests/fixtures/auth-device-server.mjs`
owns backend port 18803 and test issuer port 18804. Reverse those ports only on
the intended device, run instrumentation's `auth-live` mode, then stop the server
and remove those reverse entries. This is a local test identity, not a real
Google/Apple/enterprise account. Debug auth origin override enables provider
`test` only when explicitly provided; release builds ignore debug overrides.

See `packages/auth/CONTRACT.md` for endpoint and bridge shapes. Run iOS builds
with `DEVELOPER_DIR=/Applications/Xcode.RC.app/Contents/Developer`; discover a
current simulator destination instead of assuming a device identifier.

## Deployment boundary

This is an isolated prototype, not a hosted authentication offering. Its SQLite
store is intended for one host with a private persistent filesystem. Multiple
stateless/serverless instances need a shared transactional implementation.
Production also needs ingress rate limits, recovery/account management,
operational key/backup policy, and configured provider/domain associations. The
prototype introduces no deployment, cloud account, or provider credential.
