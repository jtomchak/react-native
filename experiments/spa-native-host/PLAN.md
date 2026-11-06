# Next.js SPA native host prototype

Status: prototype implemented, manual acceptance gates remain, 2026-11-05. The user approved
the isolated runtime dependencies and the new iOS prototype's development
provisioning. See README.md and evidence/VERIFICATION.md for actual results;
this document records design intent, not a claim that every gate has passed.
The earlier `../native-host/` experiment remains independent.

## Product hypothesis

A packaged Next.js SPA can use an independently implemented native host and
WebView transport to drive native navigation, haptics, still-photo capture, and
persistent storage on iOS and Android. A small injected SDK exposes those
capabilities to web documents, independent of Next.js, React, Stimulus, or the
server framework. Optional React components provide Hotwire-style declarations
of native toolbar actions and native presentation.

Success means actual platform behavior with explicit lifecycle and capability
contracts, plus a practical development loop. This prototype establishes a
baseline; it does not presume a performance advantage over another host.

## Decisions for v0

- Fresh isolated project in `experiments/spa-native-host/`, with independent
  manifests, lockfiles, native projects, generated assets, and evidence.
- Next.js App Router, static export, client-side navigation and runtime API
  fetching. Start with finite routes `/`, `/compose/`, and `/library/`; use query
  parameters for runtime identifiers. Server Actions and request-time server
  rendering are outside the packaged client.
- Swift/UIKit/WKWebView on iOS; Kotlin/native Views/WebView on Android. One
  persistent root WebView, with real native toolbar and modal presentation.
- Our own SDK, versioned protocol, injection, transport, dispatch, and bindings.
  No Capacitor, Tauri, Hotwire/Stimulus, React Native, Hermes, or Yoga runtime.
- No mandatory Rust layer for v0. Reconsider extracting common validation or
  service logic after the same contracts work on both platforms; do not couple
  the first proof to an additional FFI/build boundary.
- Runtime SDK is dependency-light JavaScript/TypeScript. React wrappers are a
  separate package. A plain HTML fixture must exercise the same public SDK.
- Only configured application documents receive native capabilities. External
  links open outside the privileged surface; arbitrary remote pages are not
  automatically authorized. Debug development origin is explicitly configured.
- No over-the-air updater, WebView pool, general native UI tree renderer, custom
  camera preview, video, or native interactive push transition per SPA route.

## Architecture and navigation authority

```text
Next.js SPA / plain HTML fixture
             |
   framework-neutral platform SDK
   + optional React declarations
             |
   our document-scoped WebView transport
             |
   native validation and service dispatcher
             |
   native shell | haptics | camera | storage
```

Next is the authority for SPA routes and history. The native shell owns native
presentations. The host mirrors acknowledged route state for toolbar controls;
it does not maintain a second independently mutable SPA stack.

Let the platform consume Back to dismiss an active keyboard first. Remaining
Back actions share one coordinator: dismiss the top native presentation;
otherwise request one SPA history transition; otherwise use platform root
behavior (Android exits the root activity; iOS remains at the root). A web route
transition completes after a correlated committed-route acknowledgment, not when
the request is merely enqueued. Bound pending navigation and handle a missing
acknowledgment without replaying the transition. Do not call both browser Back
and the Next router for the same interaction.

Deep links resolve to validated application routes and pass through this
coordinator. Restore a small versioned route/draft checkpoint after process
termination, rather than claiming the entire browser heap is persistent.
Reject stale or duplicate route acknowledgments. Next links and ordinary web
navigation must update the same route observer.

React declarations register native toolbar actions with route/component identity,
update them as props change, and unregister on unmount. Native clicks dispatch
to the current registration only. Strict Mode, Fast Refresh, and route changes
must not accumulate callbacks or leave stale native controls.

## Initial service contracts

These are proposed SDK signatures, not existing APIs:

```ts
platform.ready(): Promise<Capabilities>
platform.navigation.back(): Promise<void>
platform.navigation.present({screen: "native-demo"}): Promise<void>
platform.navigation.dismiss(): Promise<void>
platform.haptics.impact({style: "light" | "medium" | "heavy"}): Promise<void>
platform.storage.get(key: string): Promise<string | null>
platform.storage.set(key: string, value: string): Promise<void>
platform.storage.remove(key: string): Promise<void>
platform.camera.capture(): Promise<{file: string; mimeType: string}>
platform.files.previewURL(file: string): Promise<string>
platform.files.remove(file: string): Promise<void>
```

- **Navigation:** SPA back plus a fixed native demo sheet; native title/back
  configuration and declarative toolbar actions. Native modals use platform
  presentation; transitions inside the SPA remain web transitions in v0.
- **Haptics:** light/medium/heavy impact with documented per-platform mapping.
  Return capability/unavailable errors when unsupported. Successful invocation
  does not certify that a user felt vibration or override system preferences.
- **Storage:** bounded, host-assigned namespace, string keys/values, asynchronous
  get/set/remove. Plan system SQLite transactions on a serial worker per host;
  no browser localStorage dependency. Successful writes acknowledge committed
  persistence. Specify key/value/total limits and read-after-write ordering in
  the contract. Secrets, encryption, and a cross-process database API are out
  of scope. A granted page cannot choose another namespace by passing a string.
- **Camera:** one still image through native capture UI. iOS native camera
  presentation; Android Activity Result capture into a host-owned content URI.
  Define availability, consent/permission, busy, cancellation, and failure on
  each platform. One capture at a time. Return an opaque managed file handle,
  not a raw path or base64 image. Preview only authorized handles through a
  scoped resource loader. Retain completed files until explicit deletion;
  discard abandoned temporary output and document a prototype storage quota.

## Bridge and resource lifecycle

Define versioned request/response/event/cancel envelopes with action-specific
schemas, request IDs, host/session/document identity, timeouts, and typed errors.
Use bounded JSON initially. Set explicit limits for message size, outstanding
requests, subscriptions, stored values, and native presentations before shipping
the first bridge. No arbitrary class/method invocation or native evaluation API.

Install the public SDK before page application code. Authenticate native origin
and main-frame provenance using platform metadata; do not trust origin, grant,
or document IDs supplied in JSON. Bind each accepted request to a host-issued
document session. Define provisional navigation, redirects, same-document
navigation, failed loads, new windows, and renderer replacement in both adapters.
If the adapter cannot establish provenance, dispatch no privileged action.

Native document replacement invalidates callbacks/subscriptions. SPA route
unmount releases route-scoped registrations and cancels their requests without
recreating the WebView. Every live request settles at most once. Transport retry
must never silently repeat camera launch, navigation, haptics, or storage writes.

Cancellation stops result delivery; it does not promise an OS operation stopped.
Late camera results are discarded and abandoned files removed. A storage write
may commit after cancellation; do not imply rollback. Process death abandons the
old JavaScript promise. Restore camera operation metadata only to safely clean
up or expose a documented recovery outcome, never to replay the old callback.
Preserve successful completed photo handles across ordinary app relaunches.

## Ordered implementation plan

| Step | Deliverable | Owner assignment | Exit gate |
| --- | --- | --- | --- |
| 0 | Contract, proposed exact dependencies, build targets, new app identities | Parent + planner; mapper for environment facts | Review schemas, source policy, limits, navigation rules and dependency proposal; approve new production dependencies before installation |
| 1 | Packaged Next export and minimal standalone native hosts | Web worker; iOS worker; Android worker | Both hosts launch exported assets offline, including route chunks, styles, route payloads, direct entry, reload and query strings |
| 2 | Early SDK injection, handshake, own transport and bounded dispatcher | SDK/protocol worker; platform workers | Same action from Next and plain HTML; reject unauthorized frames, malformed input, stale sessions and unsupported versions |
| 3 | Native toolbar/actions, SPA navigation coordinator, native sheet, haptics | SDK/navigation worker; platform workers | Back/deep links produce one transition; native action reaches current web handler; native haptics invocation works |
| 4 | Durable storage and draft restoration | Platform workers; web worker | Write/read/remove and failure semantics agree; acknowledged draft survives forced process termination and relaunch |
| 5 | Native photo capture, managed files and previews | Platform workers; SDK/web worker | Actual capture, cancel, unavailable/denied paths, late completion and file cleanup tested on physical devices |
| 6 | Developer CLI, inspection and automated test integration | Tooling/test worker; parent integrates | Export/sync/build/run, live development and owned cleanup work; Release excludes dev origins and test control endpoints |
| 7 | Device acceptance, baseline measurements and independent review | Parent + reviewer; test-triage for failures | Evidence matrix complete or explicit failures retained; review protocol/lifecycle/resource ownership before acceptance |

Assignments describe the implementation split. Keep one parent responsible for
protocol integration.
Platform workers own only their host directories; SDK and web workers own their
packages/apps. Coordinate shared contract changes before parallel edits. Use
targeted checks and reviewer gates for each integrated slice.

### First technical gate: asset origin

Android candidate: WebViewAssetLoader with a local HTTPS-style asset origin.
iOS candidate: WKURLSchemeHandler for a custom local origin. Prove Next route
payload fetching, browser fetch behavior, history, reload, MIME types, and photo
previews; do not assume custom-scheme behavior matches HTTPS. Restrict resource
paths and traversal, including encoded paths. Never patch generated Next output.

If the iOS candidate fails, stop that gate and evaluate a bounded loopback HTTP
asset server with explicit lifecycle and access policy, or another supported
loader. Record the selected approach and its implications before services expand.
Do not silently switch to remote production hosting or `loadHTMLString` to make
the demo pass. Unknown dynamic routes are outside the initial export contract.

### First integrated milestone

An offline Next.js app on both platforms calls our own injected bridge, updates
a real native toolbar, handles native Back, presents/dismisses a native sheet,
and invokes haptics. Camera and persistence follow once this boundary is proven.

## Proposed file layout

```text
experiments/spa-native-host/
  PLAN.md
  DEPENDENCIES.md             # proposed exact versions/classification
  protocol/                  # schemas, conformance vectors, lifecycle contract
  packages/platform-sdk/     # injected runtime and transport interface
  packages/platform-react/   # hooks, toolbar/action registration, router adapter
  apps/web/                  # Next static-export demo
  fixtures/plain-html/       # identical SDK without React/Next/Stimulus
  hosts/ios/                 # Swift host, asset loader, transport, services
  hosts/android/             # Kotlin host, asset loader, transport, services
  tooling/                   # export/sync/build/run/dev and owned cleanup
  tests/contracts/           # protocol vectors and failure paths
  tests/browser/             # Playwright DOM tests with labeled fake transport
  tests/device/              # XCTest, Android instrumentation, native observers
  evidence/                  # reports, logs, screenshots, versions and hashes
```

Build scripts stage an immutable exported asset directory plus manifest/hash;
they must not run a root monorepo install or build unrelated RN components.
Native build steps remain Xcode and Gradle. Start with lightweight orchestration;
select a Rust CLI only if it improves the measured workflow or ownership model.
Use Next's own compiler/development server rather than routing its build through
the previous Rolldown/Hermes publisher.

Development mode uses an explicitly selected reachable Next dev server and its
Fast Refresh connection. Verify real-device reachability, origin authorization,
HMR/WebSocket behavior, native declarations after Refresh, and server failure.
Native code changes rebuild; web-only edits do not reinstall the native host.
Packaged mode must work offline without a development server.

## Validation and evidence

| Surface | Required evidence |
| --- | --- |
| Protocol/SDK | Shared conformance vectors run against both native validators; malformed messages, unknown actions, duplicates, bounds, timeout/cancel/completion races and stale documents |
| Browser | Actual Next routes/forms/React registrations, ordinary HTML SDK use, Strict Mode and Refresh cleanup; fake native transport clearly labeled |
| Native integration | Actual early injection and sender checks, disallowed iframe/origin, redirect/load failure, teardown, foreground/background, browser renderer replacement and resource ownership |
| Navigation | Web/native Back, Android hardware Back, keyboard-first dismissal, deep-link entry, native sheet dismissal, duplicate/missing acknowledgments, root behavior and restored checkpoint |
| Storage | Read-after-write, missing/delete, quota/corruption failures, process termination after acknowledged commit and relaunch |
| Camera/files | Real capture and preview, cancellation, unavailable/denied capability, one-at-a-time guard, navigation during capture, activity recreation/process death, abandoned-file cleanup and handle authorization |
| Physical behavior | iPhone 12 and Pixel 2 XL if connected and compatible; freshly record OS/WebView versions and toolchains. Attended haptic sensation check; capture is not a simulated image |
| Release | Offline packaged launch; no development URL/config, inspector listener, test control/evaluation endpoints, or fake-service paths enabled |
| Baseline | Native build/install duration, web edit-to-visible duration, offline startup and memory under a specified workload; separate Debug/Release and simulator/device evidence |

Playwright Test can orchestrate assertions, reports, browser automation and custom
native observer clients. Browser Page coverage is not proof a native sheet,
permission prompt, camera, or haptic occurred. Use XCTest/Android instrumentation
and independent native observations where needed. Debug test hooks must not
grant web documents extra production capabilities. A haptic API trace proves
invocation only; a physical observation verifies perceived output separately.

Version-stamp every result and retain failures. The earlier iOS inline-history
failure is a regression scenario for the packaged-origin gate, not evidence the
new host has already failed or passed it. No new performance target is implied
by this plan; compare future baselines only with matched workloads/endpoints.

## Reuse and approval boundaries

Use `../native-host/` as reference for bounded requests/cancellation, document
identity, WebView continuity fixtures, independent native observers, and owned
subprocess cleanup. Adapt observer app-ID allowlists explicitly. Existing mobile
mounting/runtime code and Refresh publishers depend on Hermes/Yoga and are not
part of the new host. In particular, do not copy its Android
`addJavascriptInterface`/page-finished injection as the new transport design.

At implementation kickoff, propose exact compatible Next/React/React DOM and
AndroidX production dependencies separately from development tools, including
required platform minimums and installed-device compatibility. Existing
reconciler approval does not authorize these packages. No production dependency
is added here. New bundle IDs/profiles must be checked against available signing
authorization; earlier team/certificate approval does not prove new identifiers
are already provisioned. Do not create signing resources implicitly.

## Primary design references

- [Next.js static export](https://nextjs.org/docs/app/guides/static-exports):
  packaged assets, finite routes, and unsupported server-dependent features.
- [Next.js SPA patterns](https://nextjs.org/docs/app/guides/single-page-applications).
- [Android local content](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content):
  HTTPS-style assets with WebViewAssetLoader.
- [Android WebViewCompat](https://developer.android.com/reference/androidx/webkit/WebViewCompat):
  feature-detected early scripts and origin-aware message listeners.
- [WKURLSchemeHandler](https://developer.apple.com/documentation/webkit/wkurlschemehandler):
  custom resource loading; compatibility remains an implementation gate.
- [Hotwire Bridge Components](https://native.hotwired.dev/overview/bridge-components):
  interaction inspiration only; no framework dependency or compatibility promise.
- [Android TakePicture](https://developer.android.com/reference/androidx/activity/result/contract/ActivityResultContracts.TakePicture)
  and [iOS UIImagePickerController](https://developer.apple.com/documentation/uikit/uiimagepickercontroller):
  platform still-photo capture references.
