# Native authentication wire contract

Implementation contract, v1. All endpoints below are POST JSON under the exact
configured `plugins.auth.origin` and `/api/auth/`. No arbitrary authenticated proxy.
Credentials never cross the JS bridge. OAuth callback is fixed for this prototype
as `spahost-auth://callback` (query code only). Native generates cryptographically
random 32-byte base64url verifier; challenge = base64url(SHA256(verifier)).

Single declaration: `configuration/plugins.json` selects `@nativehost/auth` with
`configuration: {enabled:false, origin:null, providers:[], rpId:null}`. The host
generates bundled `plugins.auth` options; there is no second authored auth config.
Enabled requires exact HTTPS origin, approved provider ids, and RP DNS name.
Debug overrides: iOS --spa-auth-origin URL; Android spa.auth.origin URL; debug
loopback HTTP permitted only. Server config is separate, never browser assets.

* native/start {provider, challenge, callbackURL:"spahost-auth://callback"}
  -> {authorizationURL, transaction}. The URL is same auth origin and points to
  /api/auth/oauth/authorize/?transaction=... . Open external authentication browser.
* Browser callback `spahost-auth://callback?code=...`.
* native/redeem {code,verifier} -> credentials.
* native/session {} + Bearer accessToken -> session summary.
* native/refresh {refreshToken} -> rotated credentials.
* native/logout {} + Bearer accessToken -> {authenticated:false}.
* passkeys/options {operation:"authenticate"|"register"} -> {transaction,options}.
  Registration requires Bearer accessToken. Options are standard WebAuthn JSON.
* passkeys/verify {transaction,credential} -> credentials for authentication,
  or {registered:true} for registration; same Bearer required for registration.
* native/web-ticket {challenge,returnPath} + Bearer -> {ticket}.
* native/web-session {ticket,verifier} + Bearer -> session summary + Set-Cookie.
  Native redeems then imports ONLY the agreed session cookie, for exact configured
  hosted origin, through WKHTTPCookieStore/CookieManager before responding.
  This replaces browser-form bootstrap: the redemption endpoint requires native
  authorization, preventing an unsolicited cross-site login form. No cookie or
  ticket is returned to page JS. Hosted origin must equal auth origin in v1.
* web/session GET uses cookie -> summary. web/logout POST requires exact same
  Origin and cookie, revokes linked device group and clears cookie.

Credentials {accessToken,refreshToken,session}. Session summary:
{authenticated:true,user:{id,name},expiresAt} or {authenticated:false}.
Errors: HTTP JSON {error:{code,message}}; no provider exception/raw tokens.
Session cookie name `__Host-spa_session`, Secure,HttpOnly,SameSite=Lax,Path=/.
Debug loopback server uses `spa_dev_session` (never production cookie downgrade).

Bridge: auth.status {}, auth.signIn {method:"oauth",provider} or
{method:"passkey"}, auth.registerPasskey {}, auth.signOut {},
auth.syncWebSession {}. Optional auth.changed subscription carries summary only.
Status when disabled {authenticated:false,configured:false}; enabled includes
configured:true,providers:[...],passkeys:boolean. Interactive actions acquire the
existing presentation lease, bounded cancellation, and foreground admission.
A sign-in cannot replace an existing user: sign out first. Web sync is separate;
after its promise settles UI may reload to prove authenticated server rendering.
Native signout clears its secure credentials and the agreed WebView cookie even
when server is unreachable, and reports revocation failure separately.
