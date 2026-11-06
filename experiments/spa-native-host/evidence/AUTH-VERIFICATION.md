# Authentication verification — 2026-11-05

Scope: isolated `experiments/spa-native-host`. Live OAuth provider and production
passkey website associations deliberately remain unconfigured by user choice.
No cloud resources, production credentials, app IDs or provisioning profiles
were created for this change. No CocoaPods integration was added.

## Server and client

| Check | Command / evidence | Result |
| --- | --- | --- |
| Contract and tooling tests | `npm test` | 75 passed |
| Packaged Next export | `npm run export` | Compiled; 40 staged assets |
| Client browser tests | `npm run test:browser` | 26 passed; hosted cases run separately |
| Actual hosted Next regressions | `SPA_HOSTED_TEST_URL=http://127.0.0.1:18803 npm run test:hosted` | 4 passed |
| Actual auth server acceptance | `npm run test:auth` | Final production-bundle rerun: 4 passed |

Auth acceptance uses the real production Next server, openid-client and
SimpleWebAuthn. Its deliberately isolated loopback issuer signs OIDC ID tokens;
invalid signatures and nonces are rejected. Session completion and web tickets
are proof-bound and reject replay. Browser cookie installation emulates the
native cookie import into a separate context; server rendering resolves the
same user, JavaScript cannot read the HttpOnly cookie, and device logout revokes
linked web access. Chromium's virtual authenticator completes WebAuthn
registration and assertion with real signature verification. This does not prove
an OS-native passkey prompt or a real Google/Apple/enterprise provider login.

The server is initialized through the RSC graph before API tests. This caught and
fixed duplicated Error constructor identity between Next bundles. A distinct
loopback-host reconstruction mismatch was fixed by validating actual Host and
using the configured origin, with no trust in X-Forwarded-Host.

Client tests include cancellation, sanitized summaries, stale subscription
responses, no reload before native acknowledgement, hosted sign-in+sync under one
busy owner, rollback after failed cookie sync, and external account changes.
The physical run exposed two client coordination bugs that now have regression
tests: an auth event must not navigate away from a raw sign-in primitive before
its acknowledgement, and overlapping status checks must coalesce so a newer BUSY
response cannot suppress an older valid identity. Status BUSY retries are bounded
and cancellable; interactive calls retire pending reads before admission.
The mobile screenshot `auth-client-mobile.png` is browser test-double evidence.

## Native integration

| Check | Evidence | Result |
| --- | --- | --- |
| iPad iOS27.2, Xcode.RC | `ios-auth-ipad-tests.txt` | 21 passed |
| iPhone simulator retirement suite | `ios-auth-iphone-tests.txt` | 16 passed |
| Physical Pixel native auth security | `android-auth-security.txt` | 31 assertions passed |
| Physical Pixel OAuth and Next session flow | `android-auth-live.txt` | 27 assertions passed |

The final iOS application was rebuilt with Xcode.RC after the last web export;
all 40 packaged assets match the current manifest by byte count and SHA-256.

iOS checks cover real simulator Keychain storage, WK cookie import, expired
access refresh/revocation, refresh cancellation, orphan-cookie preflight, stale
bridge admission, and actual hosted retained-document retirement. The retirement
test deliberately retains the old WKWebView and proves its document marker/timer
is gone after the inert navigation commit, before cookie replacement. Phone and
iPad suites overlap; their counts are not distinct coverage totals.

Android security assertions cover real Keystore encryption/origin isolation,
strict cookie constraints, configuration, disabled capabilities, real bridge
admission, presentation cleanup and orphan-cookie rejection. The connected Pixel
2 XL (Android11/API30) also passed the full 27-assertion flow using actual Custom
Tabs and the system callback: raw SDK sign-in, native credential storage, sibling
realm destruction, HttpOnly cookie import, authenticated Next SSR, logout, and
server rejection of the old cookie. The actual React Sign in and Sign out buttons
passed the same end-user flow, including automatic cookie synchronization and
enabled controls after the new page loaded. The issuer was the isolated local
test service, not Google/Apple/enterprise production identity.
`android-auth-results.json` records the sanitized device/build receipt, commands
and stage counts. Temporary test servers are stopped; only test-created reverse
ports 18803/18804 were removed, preserving the pre-existing 18791 mapping.

Live native iOS provider interaction and physical-device passkey enrollment are
unverified pending provider/domain configuration. A build alone is not login.

## Review and practical limits

Read-only review required fixes for expired-access refresh/revocation, refresh
cancellation, client cache invalidation, native stale pixels and JavaScript
realms, stale bridge actions, and account-specific native badges. Final review
found no remaining actionable source defect in the reviewed boundary after the
inert-document retirement barrier and widget callback guards were added.

This remains a single-host prototype using private persistent SQLite and Node24.
Production needs an operational shared-store/deployment decision, ingress rate
limits, provider/domain configuration, account recovery and management, and
appropriate fresh-authentication policies. See [AUTH.md](../AUTH.md).
