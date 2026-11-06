# Hosted content, native chrome/visits and native interaction extensions

Implementation contract, 2026-11-05. Wire protocol remains v1; capabilities and
hello metadata are additive. Existing packaged/web/standard behavior stays the
default and its regression suite must continue to pass. No Capacitor/Tauri.

## Native-owned configuration

Parent stages `configuration/host-config.json` to `build/web/host-config.json`.
Hosts parse this bundled configuration, never server-supplied JavaScript, to
select sources, origin grants, tabs and resource bounds. Production hosted mode
requires the exact configured HTTPS origin, no userinfo/path/query/fragment.
Debug may explicitly select loopback HTTP; no TLS error bypass. Release ignores
Debug origin overrides. Source selection is separate from navigation and chrome.

```json
{
  "schemaVersion": 1,
  "content": {"mode": "packaged", "origin": null, "initialPath": "/"},
  "navigation": {"mode": "web", "maxLiveSurfaces": 8, "maxDepthPerTab": 4},
  "chrome": {
    "mode": "standard", "largeTitles": true, "backGestures": true,
    "tabs": [
      {"id":"overview","title":"Overview","path":"/","icon":"house"},
      {"id":"compose","title":"Compose","path":"/compose/","icon":"square.and.pencil"},
      {"id":"library","title":"Library","path":"/library/","icon":"photo"}
    ]
  },
  "notifications": {"enabled": false, "firebase": null}
}
```

Debug launch switches on iOS: `--spa-content packaged|hosted`,
`--spa-hosted-url ORIGIN`, `--spa-navigation web|native`,
`--spa-chrome standard|tabs|adaptive`; existing `--spa-dev-url` remains available.
Android equivalent Intent string extras: `spa.content`, `spa.hosted.url`,
`spa.navigation`, `spa.chrome`. Production mode/hosted origin comes from bundle;
native settings may choose only configured sources. External intents/web content
cannot choose a new privileged origin. Do not change old default test launch.

Packaged application paths remain `/`, `/compose/`, `/library/`. Hosted mode also
allows canonical relative paths under `/hosted/`, including request-time dynamic
routes such as `/hosted/item/42/`, without a native binary route-enum update.
Query is bounded as before; host, traversal, fragment, userinfo
and length validation remain strict. An external HTTPS URL is not a native visit
target; open it externally without bridge grants. Canonical deep links remain
`spahost://app/<route>`, shared with notification taps and verified HTTPS links.
Universal/App Links require an explicitly configured owned domain and deployed
AASA/assetlinks: no claim of domain verification from a custom scheme test.

Hosted mode loads the actual Next server. Same-origin cookies and browser
credentials use platform cookie stores; different-origin redirects never gain
bridge access. A server's loading failure presents native Retry / Use packaged
options. Switching source invalidates surfaces/sessions, never silently grants
the old document the new origin. Managed-file preview URLs stay on a reserved
native resource origin/path; never intercept server `_next` or arbitrary APIs.
Content origin, photo origin and external web network policy must be distinct.

## Hello metadata, surfaces and active ownership

Existing hello result adds optional `host`:

```json
{"apiVersion":2,"contentMode":"hosted","navigationMode":"native",
 "chromeMode":"adaptive","surfaceId":"native-issued","activeTab":"overview"}
```

This object is nested at result.host. Old clients can ignore it. Each surface has
its own WebView, document nonce, session, request IDs and toolbar registration.
No WebView pool or reattachment across route controllers. At most 8 live
surfaces globally and depth 4 per tab, enforced natively before creation.
Application services (SQLite admission, camera/share/biometric busy ownership,
managed files and notification state) are shared, not recreated per surface.
Direct HostViewController tests may construct an independent service context.

Only the visible foreground surface can change chrome, navigate, or present
camera/share/biometric/permission UI. Hidden surfaces preserve local form state
but cannot commandeer visible UI. Popping/disposal invalidates pending callbacks
and subscriptions; late completions cannot enter another surface. Presentation
leases must identify the owner/request rather than release another request's
busy state. Notification taps route through the native coordinator, not a hidden
document's event callback. Keep independent disk-work bounds across surfaces.

## Native visits and chrome

- `navigation.visit {path,presentation:"push"|"replace"|"modal"}` is opt-in and
  available in navigation.mode=native. It creates a route-owned native surface.
  Resolve after native presentation commits with `{surfaceId,path}`; a separate
  content error is not a successful server load. Duplicate/repeated hidden-source
  requests must not create multiple screens. Native loading/error/Retry/Back
  remains usable on server failure.
- Ordinary Next links keep web routing. `NativeLink` invokes native visits only
  with native-mode metadata/capability; otherwise it behaves as a Next link.
  Never let both routers process the same click.
- Back priority: IME/native transient presentation first; current surface's
  acknowledged web history next; native visit pop next; platform root behavior
  last. Pure native-visit screens load direct URLs, so they pop natively. UIKit
  native pop gesture is enabled only when it owns Back (no local web history);
  a cancelled interactive gesture must preserve stack and surface/session.
- iOS: standard existing shell; tabs use UITabBarController with per-tab
  UINavigationController; adaptive iPad uses UISplitViewController with a real
  native primary destination list and secondary navigation/detail. Phone adaptive
  uses tabs. Use actual native navigation bars/large titles, safe areas, selected
  state and accessibility. UIKit commits stack bookkeeping in didShow, not at
  gesture start; dispose only actually removed controllers.
- Android: actual native bottom navigation, per-tab independent surface stacks,
  single root Activity. Modern AndroidX Back progress/cancel/commit callbacks
  animate native surfaces when a native pop is possible. Cancellation restores
  transforms without popping. API30 Pixel proves system Back, not predictive
  animations; use API33+ emulator/device for real gesture evidence.
- `chrome.state {}` returns current mode, activeTab, surfaceId, depth, tabs and
  supported appearance. `chrome.selectTab {id}` selects a configured destination.
- `chrome.update {title?,largeTitle?,tabBarHidden?,toolbarHidden?,
  statusBarStyle?:"default"|"light"|"dark",badge?:{id,value:string|null}}` updates
  supported options for the visible surface only. Reject unknown keys/types;
  bound labels/badges, and never accept arbitrary origins/tab destinations/icons
  from web code. Unsupported platform options return UNSUPPORTED explicitly.
- Events: `navigation.changed`, `chrome.tabSelected`.
  Reactivation after tab selection/pop/show emits navigation.changed with
  `{reason:"activated",host:{...current hello host metadata}}`. React refreshes
  route/chrome registrations once for that activation. Never label ordinary
  navigation.update echoes as activated; use reason:"route" or no event, avoiding
  a toolbar/route update feedback loop.

## Native event subscriptions

Existing toolbar.action/navigation.back remain internal foreground core events.
New external events use `events.subscribe {event,subscription}` and
`events.unsubscribe {subscription}`. Max 32 subscriptions per surface, unique
bounded IDs; unsubscribe/dispose idempotent. Responses retain usual session and
document identity. Events add `subscription` and must match the live subscription
before SDK invokes callbacks. SDK `on` installs native subscriptions for new
events lazily after ready; removal before ready must not resurrect one.
Use bounded application buffering for initial links/notification taps/token
updates (max32); no raw token/notification payload logging. Foreground owner
selection, not web claimed identifiers, governs delivery. Typed payloads and
bounded JSON remain required; no arbitrary evaluation or class invocation.

## Four native integrations

The user selected biometric authentication as the fourth integration. Material
1.13.0 and Firebase Messaging 26.0.1 were approved; real push provider/delivery
configuration is explicitly deferred by the user.

1. **Notifications/push:** `notifications.status {}` returns authorization and
   configured provider availability. `notifications.requestPermission {}` asks
   via OS once as appropriate; `notifications.register {}` returns
   `{provider:"apns"|"fcm",token,environment}` only after actual provider success.
   Missing config/entitlement returns UNAVAILABLE, not a fake token. iOS uses
   UNUserNotificationCenter and APNs; Android uses approved FirebaseMessaging
   dependency if approved, with manual FirebaseOptions from native configuration.
   Do not infer a production Firebase project or embed sender credentials. Events
   `notifications.token`, `.received`, `.opened`; validate/deduplicate canonical
   navigation paths from taps, foreground/background/cold launch lifecycle.
   Local notification/simulator payload tests are separate from APNs/FCM delivery.
2. **Deep links:** `links.getInitial {}` returns initial canonical link or null;
   `links.opened` reports subsequent validated links. Route through the same tab/
   visit coordinator exactly once. Provide AASA/assetlinks templates/tooling but
   do not deploy them or claim verified domains without an owned HTTPS origin.
3. **System share:** `share.present {text?,url?,file?}` accepts bounded text,
   HTTPS URL, or a known managed file handle (at least one). No arbitrary paths.
   iOS UIActivityViewController correctly anchors popover on iPad; Android system
   chooser with scoped content URI grants. Results describe actual observed
   presented/selected/cancelled state; never claim receiver delivery succeeded.
4. **Biometrics:** `biometrics.status {}` returns availability/
   enrollment; `biometrics.authenticate {reason}` uses LAContext / platform
   Android BiometricPrompt (API28+, older API returns UNAVAILABLE), bounded
   reason, actual user presence, cancellation/lifecycle cleanup and typed errors.
   Return authenticated only from OS success callback; no fake auto-success.

All old camera/haptics/storage APIs remain intact. Requests and OS prompts use
the application presentation gate; old or background surfaces cannot launch UI.

## Server and tooling boundary

Web worker owns SDK/React, apps/web, new apps/server and browser/contract tests.
New apps/server shares client demo UI but has a dynamic `/hosted/` server page
with request nonce/time and a server-side cookie action. Production Next build/
start must be exercised, not just next dev. Dist/build dirs are separate from
static export and must not overwrite packaged artifacts. Static export excludes
dynamic/server-only routes. Next/RSC remains the only web rendering owner;
do not install Turbo Drive into the React document.

Parent owns configuration/protocol/tooling/root package scripts/dependency
approval/integration docs. iOS worker owns entire hosts/ios; Android worker owns
entire hosts/android. No new production dependency before approval. No commits,
cloud deployment, APNs key creation, FCM project creation or secret printing.

## Validation gates

Preserve existing packaged tests. Add hosted SSR nonce/cookie/server action,
origin/redirect/iframe denial, remote outage/packaged fallback, native visit
push/replace/modal/pop + cancelled gesture, independent tabs/form preservation,
iPad real split/sidebar selection/collapse/resize, Android real predictive Back
on a compatible emulator, SDK events subscription races and hidden-owner denial,
share presentation, notifications unconfigured/error/token callbacks/tap routing,
biometric cancel/unavailable and attended auth. Separate actual push delivery,
verified domains, real user presence and simulator fixtures in evidence.
