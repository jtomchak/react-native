# Hosted Next.js, native chrome and native interactions

The prototype now has independent content, navigation and chrome choices. The
default remains the original packaged SPA with Next web history and the standard
native toolbar. No Capacitor or Turbo Drive is installed.

| Axis | Choices |
| --- | --- |
| Content | Packaged static export; hosted production Next.js server |
| Navigation | Web history; opt-in native visits |
| Native chrome | Standard; tabs; adaptive iPad sidebar/detail (phone tabs) |

## Build the two web artifacts

From this directory:

```sh
npm ci --ignore-scripts
npm run export
npm run hosted:build
npm run hosted:start -- --port 18797
```

Packaged assets live in `build/web/`; the independently built production server
lives in `apps/server/.next-server/standalone/`. Building the server does not
replace packaged assets. This command binds an owned loopback test server, not a
public deployment. Its explicit non-Secure cookie override is limited to this
HTTP loopback runner; the server action defaults to Secure cookies for deployment.

`/hosted/` renders a new nonce and timestamp per request, reads an HttpOnly
preference cookie, and offers a Server Action to update it. `/hosted/item/[id]/`
demonstrates a new dynamic server screen without adding an ID to the native
binary. Native visits allow the canonical `/hosted/` namespace only in hosted
mode. Packaged mode retains its finite exported routes. Other origins never gain
native grants merely because a page links or redirects to them.

For an owned production HTTPS deployment, use the generated standalone server
and its copied public/static directories, then configure that exact origin in
the native build. See [configuration/README.md](configuration/README.md). No
cloud resources or public endpoint are provisioned by these commands.

## Select native modes for a local Debug run

Build/install the native apps using their host guides first. For an iOS simulator:

```sh
xcrun simctl launch --terminate-running-process SIMULATOR_ID dev.spahost.prototype \
  --spa-content hosted --spa-hosted-url http://127.0.0.1:18797 \
  --spa-navigation native --spa-chrome adaptive
```

For Android, forward only the chosen development port and explicitly select it:

```sh
adb -s DEVICE reverse tcp:18797 tcp:18797
adb -s DEVICE shell am start -S -n dev.spahost.prototype/.HostActivity \
  --es spa.content hosted --es spa.hosted.url http://127.0.0.1:18797 \
  --es spa.navigation native --es spa.chrome tabs
# When finished, remove only this owned reverse:
adb -s DEVICE reverse --remove tcp:18797
```

For packaged native chrome, omit the hosted URL and select packaged content.
Release reads trusted bundled configuration and requires HTTPS for hosted
content; it does not accept an arbitrary origin supplied by a web document or
external intent. A hosted load failure exposes native retry/packaged fallback.

## Native navigation and chrome

`NativeLink` invokes `navigation.visit` only when native mode is enabled. In web
mode and an ordinary browser it remains a Next client transition. Ordinary Next
links continue to use web routing; both routers must never process one click.

Native visits support push, replace and modal presentation. Every route owns a
bounded WebView surface and its own document/session, rather than borrowing from
a global pool. Tabs retain independent stacks and form state. Shared app services
own SQLite admission, managed files, notification state and native presentation
leases. Only the active surface can commandeer native controls or presentation.

iOS uses UIKit tab/navigation controllers and an adaptive split view with a real
native destination list on iPad. Pure native visit screens support UIKit edge
pop; a cancelled gesture leaves the original stack intact. Android uses Material
bottom navigation and native surface stacks with AndroidX predictive Back
progress/cancel/commit. Root Back delegates to Android so the OS can own the
back-to-home preview. API30 system Back is separate evidence from modern
predictive gestures.

The bridge exposes `chrome.state`, `chrome.selectTab` and `chrome.update` for
titles, supported large-title behavior, bar visibility, status style and badges.
Appearance belongs to a surface and is restored on activation. Tab destinations,
origin grants and resource limits remain native-owned configuration.

## Four native integrations

| Integration | Implemented boundary | External or attended gate |
| --- | --- | --- |
| Push notifications | OS authorization/status; APNs/FCM registration, token/receive/open callbacks; tap-to-route adapter | User explicitly deferred provider configuration and real remote delivery |
| Deep links | Canonical custom scheme, initial/warm events, shared tab/visit routing; configured HTTPS handlers | Universal/App Link verification requires an owned HTTPS domain, signing configuration and deployed association files |
| System sharing | Native share UI for text, HTTPS URL or managed photo; iPad popover anchoring | Selecting/presenting a receiver is not proof that it delivered or persisted the content |
| Biometrics | Native availability/enrollment, OS authentication and cancellation | Success requires actual OS user-presence authentication; simulator fixtures do not prove physical user presence |

Camera, haptics and durable SQLite storage remain available through the same SDK.
Push registration without configured support returns typed UNAVAILABLE; no fake
token or local-notification substitution is used. Firebase client configuration
contains no sender private key; the iOS capability/entitlement is opt-in.

## Verify

```sh
npm test
npm run test:browser
# With the production loopback server already running:
npm run test:hosted
```

Browser native-action tests use a clearly identified mock transport. Native
platform tests and OS interaction checks are recorded separately. See
[protocol/EXTENSIONS.md](protocol/EXTENSIONS.md),
[iOS guide](hosts/ios/README.md), [Android guide](hosts/android/README.md), and
[evidence/HOSTED-VERIFICATION.md](evidence/HOSTED-VERIFICATION.md) for actual
results and remaining gates.
